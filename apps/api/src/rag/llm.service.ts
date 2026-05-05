import { Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { ChunkWithScore, RagService } from './rag.service';
import { calculateCost } from '../user-management/llm-cost-calculator';
import * as crypto from 'crypto';

interface GenerateRagAnswerInput {
  courseId: string;
  userId: string;
  query: string;
  chunks: ChunkWithScore[];
  strictSource: boolean;
}

interface GenerateContentDraftInput {
  courseId: string;
  userId: string;
  title: string;
  prompt: string;
  chunks: ChunkWithScore[];
  strictSource: boolean;
}

interface LlmResponse {
  answer: string;
  citations: Array<{
    chunkId: string;
    documentTitle: string;
    pageNumber: number | null;
    quote: string;
  }>;
  strictSourceValid: boolean;
  notEnoughInfo: boolean;
  model: string;
  promptTokens: number;
  completionTokens: number;
}

interface UserLlmSettings {
  provider: string | null;
  model: string | null;
  hasKey: boolean;
}

// Simple symmetric encryption for storing API keys at rest
const ENCRYPTION_ALGO = 'aes-256-gcm';

@Injectable()
export class LlmService {
  private readonly logger = new Logger(LlmService.name);
  private readonly encryptionKey: Buffer;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly ragService: RagService,
  ) {
    // Derive a 32-byte key from JWT_SECRET for encrypting stored API keys
    const secret = this.config.get<string>('JWT_SECRET', 'dev-secret-change-in-production');
    this.encryptionKey = crypto.scryptSync(secret, 'llm-key-salt', 32);
  }

  // ─── API Key Management ─────────────────────────────────

  private encrypt(text: string): string {
    const iv = crypto.randomBytes(16);
    const cipher = crypto.createCipheriv(ENCRYPTION_ALGO, this.encryptionKey, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    const authTag = cipher.getAuthTag();
    // Store as iv:authTag:encrypted (all hex)
    return `${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted.toString('hex')}`;
  }

  private decrypt(data: string): string {
    const parts = data.split(':');
    const iv = Buffer.from(parts[0]!, 'hex');
    const authTag = Buffer.from(parts[1]!, 'hex');
    const encrypted = Buffer.from(parts[2]!, 'hex');
    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGO, this.encryptionKey, iv);
    decipher.setAuthTag(authTag);
    return decipher.update(encrypted) + decipher.final('utf8');
  }

  async saveApiKey(userId: string, provider: string, apiKey: string, model?: string) {
    const encrypted = this.encrypt(apiKey);
    const defaultModel = provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini';

    await this.prisma.user.update({
      where: { id: userId },
      data: {
        llmProvider: provider,
        encryptedApiKey: encrypted,
        llmModel: model || defaultModel,
      },
    });

    return { saved: true, provider, model: model || defaultModel };
  }

  async removeApiKey(userId: string) {
    await this.prisma.user.update({
      where: { id: userId },
      data: {
        llmProvider: null,
        encryptedApiKey: null,
        llmModel: null,
      },
    });
    return { removed: true };
  }

  async getUserLlmSettings(userId: string): Promise<UserLlmSettings> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { llmProvider: true, llmModel: true, encryptedApiKey: true },
    });
    return {
      provider: user?.llmProvider || null,
      model: user?.llmModel || null,
      hasKey: !!user?.encryptedApiKey,
    };
  }

  private async getUserApiKey(
    userId: string,
  ): Promise<{ apiKey: string; model: string; provider: string } | null> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { llmProvider: true, llmModel: true, encryptedApiKey: true },
    });
    if (!user?.encryptedApiKey) return null;
    try {
      const apiKey = this.decrypt(user.encryptedApiKey);
      const provider = user.llmProvider || 'openai';
      const defaultModel = provider === 'gemini' ? 'gemini-2.0-flash' : 'gpt-4o-mini';
      return { apiKey, model: user.llmModel || defaultModel, provider };
    } catch {
      this.logger.error(`Failed to decrypt API key for user ${userId}`);
      return null;
    }
  }

  // ─── RAG Answer Generation ─────────────────────────────

  async generateRagAnswer(input: GenerateRagAnswerInput): Promise<LlmResponse> {
    const startTime = Date.now();

    if (input.chunks.length === 0) {
      return this.noSourcesResponse(input);
    }

    const contextBlock = this.buildContextBlock(input.chunks);
    const systemPrompt = this.buildRagSystemPrompt(input.strictSource);
    const userPrompt = `${contextBlock}\n\n---\n\nQuestion: ${input.query}`;

    const credentials = await this.getUserApiKey(input.userId);
    const result = await this.callLlm(systemPrompt, userPrompt, credentials);

    const citations = this.extractCitations(result.content, input.chunks);

    let strictSourceValid = true;
    let notEnoughInfo = false;

    if (input.strictSource) {
      const validation = this.ragService.validateCitations(result.content, citations, input.chunks);
      strictSourceValid = validation.valid;

      if (
        result.content.includes('NOT_ENOUGH_INFO') ||
        result.content.includes('insufficient sources')
      ) {
        notEnoughInfo = true;
      }
    }

    const durationMs = Date.now() - startTime;
    const modelUsed = credentials?.model || 'template';

    await this.createAuditLog({
      courseId: input.courseId,
      userId: input.userId,
      action: 'query_rag',
      model: modelUsed,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
      inputPayload: {
        query: input.query,
        chunkCount: input.chunks.length,
        strictSource: input.strictSource,
      },
      outputPayload: {
        answerLength: result.content.length,
        citationCount: citations.length,
        strictSourceValid,
        notEnoughInfo,
      },
    });

    // Log LLM usage for cost tracking
    await this.logLlmUsage({
      userId: input.userId,
      courseId: input.courseId,
      provider: credentials?.provider || 'template',
      model: modelUsed,
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      feature: 'query_rag',
    });

    return {
      answer: result.content,
      citations,
      strictSourceValid,
      notEnoughInfo,
      model: modelUsed,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
    };
  }

  // ─── Content Draft Generation ──────────────────────────

  async generateContentDraft(input: GenerateContentDraftInput) {
    const startTime = Date.now();

    if (input.chunks.length === 0 && input.strictSource) {
      const draft = await this.prisma.contentDraft.create({
        data: {
          courseId: input.courseId,
          createdById: input.userId,
          title: input.title,
          contentMdx:
            '> **NOT_ENOUGH_INFO**: No source documents are available for this course. Please upload reference materials first.',
          citations: [],
          status: 'DRAFT',
        },
      });
      return { draft, notEnoughInfo: true, debugInfo: {} };
    }

    const contextBlock = this.buildContextBlock(input.chunks);
    const systemPrompt = this.buildContentGenerationPrompt(input.strictSource);
    const userPrompt = `${contextBlock}\n\n---\n\nGenerate course content for: "${input.title}"\n\nTeacher instructions: ${input.prompt}`;

    const credentials = await this.getUserApiKey(input.userId);
    const result = await this.callLlm(systemPrompt, userPrompt, credentials);

    const citations = this.extractCitations(result.content, input.chunks);

    let strictSourceValid = true;
    let notEnoughInfo = false;

    if (input.strictSource) {
      const validation = this.ragService.validateCitations(result.content, citations, input.chunks);
      strictSourceValid = validation.valid;
      notEnoughInfo =
        result.content.includes('NOT_ENOUGH_INFO') ||
        result.content.includes('insufficient sources');
    }

    const durationMs = Date.now() - startTime;
    const modelUsed = credentials?.model || 'template';

    const draft = await this.prisma.contentDraft.create({
      data: {
        courseId: input.courseId,
        createdById: input.userId,
        title: input.title,
        contentMdx: result.content,
        citations: citations as unknown as import('@prisma/client').Prisma.InputJsonValue,
        status: 'DRAFT',
      },
    });

    await this.createAuditLog({
      draftId: draft.id,
      courseId: input.courseId,
      userId: input.userId,
      action: 'generate_content',
      model: modelUsed,
      promptTokens: result.promptTokens,
      completionTokens: result.completionTokens,
      durationMs,
      inputPayload: {
        title: input.title,
        prompt: input.prompt,
        chunkCount: input.chunks.length,
        strictSource: input.strictSource,
      },
      outputPayload: {
        draftId: draft.id,
        contentLength: result.content.length,
        citationCount: citations.length,
        strictSourceValid,
        notEnoughInfo,
      },
    });

    // Log LLM usage for cost tracking
    await this.logLlmUsage({
      userId: input.userId,
      courseId: input.courseId,
      provider: credentials?.provider || 'template',
      model: modelUsed,
      inputTokens: result.promptTokens,
      outputTokens: result.completionTokens,
      feature: 'content_generation',
    });

    return {
      draft,
      citations,
      strictSourceValid,
      notEnoughInfo,
      debugInfo: {
        model: modelUsed,
        promptTokens: result.promptTokens,
        completionTokens: result.completionTokens,
        durationMs,
        chunksUsed: input.chunks.map((c) => ({
          id: c.id,
          documentTitle: c.documentTitle,
          pageNumber: c.pageNumber,
          rerankerScore: c.rerankerScore,
        })),
      },
    };
  }

  // ─── Draft Management ──────────────────────────────────

  async listDrafts(courseId: string) {
    return this.prisma.contentDraft.findMany({
      where: { courseId },
      orderBy: { createdAt: 'desc' },
      select: {
        id: true,
        title: true,
        status: true,
        version: true,
        createdAt: true,
        reviewedAt: true,
        createdBy: { select: { id: true, name: true } },
      },
    });
  }

  async getDraft(draftId: string) {
    const draft = await this.prisma.contentDraft.findUnique({
      where: { id: draftId },
      include: {
        createdBy: { select: { id: true, name: true } },
        auditLogs: {
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: {
            id: true,
            action: true,
            model: true,
            promptTokens: true,
            completionTokens: true,
            durationMs: true,
            createdAt: true,
          },
        },
      },
    });
    if (!draft) throw new NotFoundException(`Draft ${draftId} not found`);
    return draft;
  }

  async approveDraft(draftId: string, userId: string, editedContent?: string) {
    const draft = await this.prisma.contentDraft.findUnique({ where: { id: draftId } });
    if (!draft) throw new NotFoundException(`Draft ${draftId} not found`);

    return this.prisma.contentDraft.update({
      where: { id: draftId },
      data: {
        status: 'APPROVED',
        reviewedAt: new Date(),
        contentMdx: editedContent || draft.contentMdx,
      },
    });
  }

  async rejectDraft(draftId: string, _userId: string) {
    const draft = await this.prisma.contentDraft.findUnique({ where: { id: draftId } });
    if (!draft) throw new NotFoundException(`Draft ${draftId} not found`);

    return this.prisma.contentDraft.update({
      where: { id: draftId },
      data: {
        status: 'REJECTED',
        reviewedAt: new Date(),
      },
    });
  }

  // ─── Audit Logs ────────────────────────────────────────

  async getAuditLogs(courseId: string, limit: number = 50) {
    return this.prisma.llmAuditLog.findMany({
      where: { courseId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        action: true,
        model: true,
        promptTokens: true,
        completionTokens: true,
        durationMs: true,
        errorMessage: true,
        createdAt: true,
        draft: { select: { id: true, title: true } },
      },
    });
  }

  // ─── Public Helpers ──────────────────────────────────────

  async hasApiKey(userId: string): Promise<boolean> {
    const credentials = await this.getUserApiKey(userId);
    return credentials !== null;
  }

  // ─── Available-models discovery ────────────────────────
  //
  // Hardcoded model lists in the UI go stale fast — Google retires preview
  // model IDs every few months and dated suffixes like
  // `gemini-2.5-pro-preview-05-06` start returning 404 without warning.
  // listAvailableModels() asks the provider what's actually live (filtered
  // to chat-capable models) and falls back to a verified static list if the
  // user has no key, the provider call fails, or the response is empty.

  private static readonly STATIC_GEMINI_FALLBACK: Array<{ value: string; label: string }> = [
    { value: 'gemini-2.0-flash', label: 'Gemini 2.0 Flash (fast, GA)' },
    { value: 'gemini-2.5-flash-lite', label: 'Gemini 2.5 Flash Lite (cheapest, GA)' },
    { value: 'gemini-2.5-flash', label: 'Gemini 2.5 Flash (best price/quality, GA)' },
    { value: 'gemini-2.5-pro', label: 'Gemini 2.5 Pro (most capable, GA)' },
    { value: 'gemini-flash-latest', label: 'Gemini Flash Latest (auto-updates)' },
    { value: 'gemini-pro-latest', label: 'Gemini Pro Latest (auto-updates)' },
  ];

  private static readonly STATIC_OPENAI_FALLBACK: Array<{ value: string; label: string }> = [
    { value: 'gpt-4o-mini', label: 'GPT-4o Mini (fast, recommended)' },
    { value: 'gpt-4o', label: 'GPT-4o (most capable)' },
    { value: 'gpt-4-turbo', label: 'GPT-4 Turbo' },
    { value: 'gpt-3.5-turbo', label: 'GPT-3.5 Turbo (cheapest)' },
  ];

  async listAvailableModels(
    userId: string,
    provider: 'openai' | 'gemini',
  ): Promise<{ models: Array<{ value: string; label: string }>; source: 'live' | 'fallback' }> {
    const credentials = await this.getUserApiKey(userId);
    const apiKey = credentials?.provider === provider ? credentials.apiKey : null;

    if (!apiKey) {
      return {
        models:
          provider === 'gemini'
            ? LlmService.STATIC_GEMINI_FALLBACK
            : LlmService.STATIC_OPENAI_FALLBACK,
        source: 'fallback',
      };
    }

    try {
      const live =
        provider === 'gemini'
          ? await this.fetchGeminiModels(apiKey)
          : await this.fetchOpenAiModels(apiKey);
      if (live.length === 0) {
        // Empty after filtering means the key has restricted access; surface
        // the fallback so the dropdown isn't empty.
        throw new Error('provider returned no chat-capable models');
      }
      return { models: live, source: 'live' };
    } catch (err) {
      this.logger.warn(
        `listAvailableModels(${provider}) live fetch failed for user ${userId}: ${
          err instanceof Error ? err.message : err
        } — returning static fallback`,
      );
      return {
        models:
          provider === 'gemini'
            ? LlmService.STATIC_GEMINI_FALLBACK
            : LlmService.STATIC_OPENAI_FALLBACK,
        source: 'fallback',
      };
    }
  }

  private async fetchGeminiModels(
    apiKey: string,
  ): Promise<Array<{ value: string; label: string }>> {
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey}&pageSize=200`,
    );
    if (!res.ok) {
      throw new Error(`gemini models.list HTTP ${res.status}`);
    }
    const data = (await res.json()) as {
      models?: Array<{ name?: string; supportedGenerationMethods?: string[] }>;
    };
    const all = data.models ?? [];

    // Filter: must support generateContent, must be a Gemini chat model (skip
    // gemma-*, lyria-*, deep-research-*, robotics, tts, image-only, etc.) so
    // teachers don't see hundreds of irrelevant entries.
    const chat = all
      .filter((m) => (m.supportedGenerationMethods ?? []).includes('generateContent'))
      .map((m) => (m.name ?? '').replace(/^models\//, ''))
      .filter(
        (name) =>
          /^gemini-/.test(name) &&
          !/-tts$/.test(name) &&
          !/-image(-preview)?$/.test(name) &&
          !/-customtools$/.test(name) &&
          !/computer-use/.test(name) &&
          !/robotics/.test(name) &&
          !/deep-research/.test(name),
      );

    // Sort: GA stable first, then "latest" aliases, then previews.
    const score = (name: string) => {
      if (/preview/.test(name)) return 3;
      if (/latest/.test(name)) return 2;
      return 1;
    };
    chat.sort((a, b) => {
      const sa = score(a);
      const sb = score(b);
      if (sa !== sb) return sa - sb;
      return a.localeCompare(b);
    });

    return chat.map((name) => ({ value: name, label: prettifyGeminiLabel(name) }));
  }

  private async fetchOpenAiModels(
    apiKey: string,
  ): Promise<Array<{ value: string; label: string }>> {
    const res = await fetch('https://api.openai.com/v1/models', {
      headers: { Authorization: `Bearer ${apiKey}` },
    });
    if (!res.ok) {
      throw new Error(`openai /v1/models HTTP ${res.status}`);
    }
    const data = (await res.json()) as { data?: Array<{ id?: string }> };
    const all = (data.data ?? []).map((m) => m.id ?? '').filter(Boolean);

    // OpenAI's /v1/models lists *every* model the key has access to including
    // embeddings, whisper, dall-e, tts, fine-tuned variants, realtime, etc.
    // Most aren't usable as chat-completions targets — keep only the gpt/o*
    // chat families.
    const chatPrefixes = ['gpt-4', 'gpt-3.5', 'gpt-5', 'o1', 'o3', 'o4'];
    const exclude = [/embedding/, /whisper/, /tts/, /dall-e/, /audio/, /realtime/, /:/];
    const chat = all.filter(
      (id) => chatPrefixes.some((p) => id.startsWith(p)) && !exclude.some((rx) => rx.test(id)),
    );
    chat.sort((a, b) => a.localeCompare(b));

    return chat.map((id) => ({ value: id, label: id }));
  }

  // ─── End available-models ──────────────────────────────

  async callLlmForUser(
    userId: string,
    systemPrompt: string,
    userPrompt: string,
    usageContext?: { feature: string; courseId?: string; triggeredByUserId?: string },
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    const credentials = await this.getUserApiKey(userId);
    const result = await this.callLlm(systemPrompt, userPrompt, credentials, options);

    if (usageContext) {
      await this.logLlmUsage({
        userId: usageContext.triggeredByUserId || userId,
        courseId: usageContext.courseId,
        provider: credentials?.provider || 'template',
        model: credentials?.model || 'template',
        inputTokens: result.promptTokens,
        outputTokens: result.completionTokens,
        feature: usageContext.feature,
      });
    }

    return result;
  }

  async logLlmUsage(params: {
    userId: string;
    courseId?: string;
    provider: string;
    model: string;
    inputTokens: number;
    outputTokens: number;
    feature: string;
    metadata?: Record<string, unknown>;
  }): Promise<void> {
    try {
      const cost = await calculateCost(this.prisma, {
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        model: params.model,
        provider: params.provider,
      });

      await this.prisma.llmUsageLog.create({
        data: {
          userId: params.userId,
          courseId: params.courseId || null,
          provider: params.provider,
          model: params.model,
          inputTokens: params.inputTokens,
          outputTokens: params.outputTokens,
          totalTokens: params.inputTokens + params.outputTokens,
          inputCost: cost.inputCost,
          outputCost: cost.outputCost,
          totalCost: cost.totalCost,
          feature: params.feature,
          metadata:
            (params.metadata as import('@prisma/client').Prisma.InputJsonValue) ?? undefined,
        },
      });
    } catch (err) {
      this.logger.error('Failed to log LLM usage', err);
    }
  }

  // ─── Private Helpers ───────────────────────────────────

  private async callLlm(
    systemPrompt: string,
    userPrompt: string,
    credentials: { apiKey: string; model: string; provider: string } | null,
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    if (credentials) {
      if (credentials.provider === 'gemini') {
        return this.callGeminiApi(
          systemPrompt,
          userPrompt,
          credentials.apiKey,
          credentials.model,
          options,
        );
      }
      return this.callOpenAiApi(
        systemPrompt,
        userPrompt,
        credentials.apiKey,
        credentials.model,
        options,
      );
    }
    // Fallback: built-in template-based generation (no API key configured)
    return this.generateWithoutApi(systemPrompt, userPrompt);
  }

  private async callOpenAiApi(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string,
    model: string,
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    try {
      const body: Record<string, unknown> = {
        model,
        max_tokens: options?.maxTokens || 4096,
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
      };
      if (options?.jsonMode) {
        body.response_format = { type: 'json_object' };
      }
      const response = await fetch('https://api.openai.com/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`OpenAI API error: ${response.status} ${errorText}`);
        throw new Error(`OpenAI API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        choices?: Array<{ message?: { content?: string } }>;
        usage?: { prompt_tokens?: number; completion_tokens?: number };
      };
      return {
        content: data.choices?.[0]?.message?.content || '',
        promptTokens: data.usage?.prompt_tokens || 0,
        completionTokens: data.usage?.completion_tokens || 0,
      };
    } catch (error) {
      this.logger.error('Failed to call OpenAI API', error);
      if (options?.jsonMode) throw error;
      // Fallback to template-based generation
      return this.generateWithoutApi(systemPrompt, userPrompt);
    }
  }

  private async callGeminiApi(
    systemPrompt: string,
    userPrompt: string,
    apiKey: string,
    model: string,
    options?: { jsonMode?: boolean; maxTokens?: number },
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const generationConfig: Record<string, unknown> = {
        maxOutputTokens: options?.maxTokens || 4096,
      };
      if (options?.jsonMode) {
        generationConfig.responseMimeType = 'application/json';
      }

      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          systemInstruction: { parts: [{ text: systemPrompt }] },
          contents: [{ role: 'user', parts: [{ text: userPrompt }] }],
          generationConfig,
        }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        this.logger.error(`Gemini API error: ${response.status} ${errorText}`);
        throw new Error(`Gemini API error: ${response.status}`);
      }

      const data = (await response.json()) as {
        candidates?: Array<{ content?: { parts?: Array<{ text?: string }> } }>;
        usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number };
      };

      return {
        content: data.candidates?.[0]?.content?.parts?.[0]?.text || '',
        promptTokens: data.usageMetadata?.promptTokenCount || 0,
        completionTokens: data.usageMetadata?.candidatesTokenCount || 0,
      };
    } catch (error) {
      this.logger.error('Failed to call Gemini API', error);
      if (options?.jsonMode) throw error;
      // Fallback to template-based generation
      return this.generateWithoutApi(systemPrompt, userPrompt);
    }
  }

  private async generateWithoutApi(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<{ content: string; promptTokens: number; completionTokens: number }> {
    const sourceMatch = userPrompt.match(/Source \d+[\s\S]*?(?=---|$)/g);
    const questionMatch = userPrompt.match(/Question:\s*(.*)/);
    const generateMatch = userPrompt.match(/Generate course content for:\s*"([^"]+)"/);
    const instructionsMatch = userPrompt.match(/Teacher instructions:\s*([\s\S]*?)$/);

    let content = '';

    if (generateMatch) {
      const title = generateMatch[1] || '';
      const instructions = instructionsMatch?.[1]?.trim() || '';
      content = this.buildTemplateContent(title, instructions, sourceMatch || []);
    } else if (questionMatch) {
      const question = questionMatch[1] || '';
      content = this.buildTemplateAnswer(question, sourceMatch || []);
    } else {
      content =
        '> **NOT_ENOUGH_INFO**: Unable to process the request. Please provide a clear question or generation prompt.';
    }

    return {
      content,
      promptTokens: Math.ceil(userPrompt.length / 4),
      completionTokens: Math.ceil(content.length / 4),
    };
  }

  private buildTemplateContent(title: string, instructions: string, sources: string[]): string {
    if (sources.length === 0) {
      return `> **NOT_ENOUGH_INFO**: No source documents available to generate content for "${title}". Please upload reference materials and try again.`;
    }

    const sourceTexts = sources.map((s) => {
      const contentMatch = s.match(/Content:\s*([\s\S]*?)(?=\n\n|$)/);
      return contentMatch?.[1]?.trim() || s;
    });

    const combinedInfo = sourceTexts.join('\n\n');
    const preview = combinedInfo.slice(0, 2000);

    let mdx = `# ${title}\n\n`;
    mdx += `${instructions ? `*Based on instructions: ${instructions}*\n\n` : ''}`;
    mdx += `## Overview\n\n`;
    mdx += `This content was generated from ${sources.length} source document(s). `;
    mdx += `Each section below is grounded in the uploaded reference materials. [1]\n\n`;
    mdx += `## Key Concepts\n\n`;

    const sentences = preview
      .split(/[.!?]+/)
      .filter((s) => s.trim().length > 20)
      .slice(0, 6);

    sentences.forEach((sentence, i) => {
      const citationNum = Math.min(i + 1, sources.length);
      mdx += `- ${sentence.trim()}. [${citationNum}]\n`;
    });

    mdx += `\n## Summary\n\n`;
    mdx += `The above content is derived from the uploaded source materials. `;
    mdx += `Please review this draft carefully before approving. [1]\n`;
    mdx += `\n---\n*This is an AI-generated DRAFT. Review and approve before publishing.*\n`;

    return mdx;
  }

  private buildTemplateAnswer(question: string, sources: string[]): string {
    if (sources.length === 0) {
      return `> **NOT_ENOUGH_INFO**: No source documents available to answer "${question}". Please upload reference materials first.`;
    }

    const sourceTexts = sources.map((s) => {
      const contentMatch = s.match(/Content:\s*([\s\S]*?)(?=\n\n|$)/);
      return contentMatch?.[1]?.trim() || s;
    });

    const combinedInfo = sourceTexts.join(' ').slice(0, 1500);

    let answer = `Based on the available source documents:\n\n`;
    answer += `${combinedInfo.slice(0, 500)}... [1]\n\n`;
    answer += `This answer is derived from ${sources.length} source chunk(s). [1]`;

    return answer;
  }

  private buildContextBlock(chunks: ChunkWithScore[]): string {
    return chunks
      .map(
        (chunk, i) =>
          `Source ${i + 1} (from "${chunk.documentTitle}", page ${chunk.pageNumber ?? 'N/A'}):\n` +
          `Content: ${chunk.content}`,
      )
      .join('\n\n');
  }

  private buildRagSystemPrompt(strictSource: boolean): string {
    let prompt = `You are an educational content assistant. Answer questions using ONLY the provided source documents.

Rules:
- Cite sources using [N] notation where N is the source number
- Every factual claim must have a citation
- Include page numbers when available`;

    if (strictSource) {
      prompt += `
- STRICT SOURCE MODE: Every paragraph MUST have at least one citation [N]
- If sources are insufficient to answer the question, respond with: "NOT_ENOUGH_INFO: The provided sources do not contain sufficient information to answer this question. Consider uploading additional materials about: [suggest topics]"
- NEVER invent information not found in the sources`;
    }

    return prompt;
  }

  private buildContentGenerationPrompt(strictSource: boolean): string {
    let prompt = `You are an educational content creator. Generate course material in MDX format using the provided source documents.

Rules:
- Output well-structured MDX with headings (##), lists, and emphasis
- Cite sources using [N] notation matching the source numbers
- Every paragraph must reference its source
- Use KaTeX for math: $inline$ or $$block$$
- Write for university-level students`;

    if (strictSource) {
      prompt += `
- STRICT SOURCE MODE: ONLY include information that can be directly traced to the sources
- Every paragraph MUST have at least one citation [N]
- If sources are insufficient, begin your response with: "NOT_ENOUGH_INFO: insufficient sources to generate content about [topic]. Please upload materials covering: [suggestions]"`;
    }

    prompt += `
- This will be a DRAFT for teacher review. Mark it clearly as AI-generated.`;

    return prompt;
  }

  private extractCitations(
    content: string,
    chunks: ChunkWithScore[],
  ): Array<{
    chunkId: string;
    documentTitle: string;
    pageNumber: number | null;
    quote: string;
  }> {
    const citationPattern = /\[(\d+)\]/g;
    const citedNumbers = new Set<number>();
    let match;

    while ((match = citationPattern.exec(content)) !== null) {
      citedNumbers.add(parseInt(match[1]!, 10));
    }

    return Array.from(citedNumbers)
      .filter((n) => n >= 1 && n <= chunks.length)
      .map((n) => {
        const chunk = chunks[n - 1]!;
        return {
          chunkId: chunk.id,
          documentTitle: chunk.documentTitle,
          pageNumber: chunk.pageNumber,
          quote: chunk.content.slice(0, 100),
        };
      });
  }

  private noSourcesResponse(_input: GenerateRagAnswerInput): LlmResponse {
    return {
      answer:
        '> **NOT_ENOUGH_INFO**: No source documents have been indexed for this course. Please upload reference materials in the Sources tab first.',
      citations: [],
      strictSourceValid: false,
      notEnoughInfo: true,
      model: 'none',
      promptTokens: 0,
      completionTokens: 0,
    };
  }

  private async createAuditLog(data: {
    draftId?: string;
    courseId: string;
    userId: string;
    action: string;
    model: string;
    promptTokens: number;
    completionTokens: number;
    durationMs: number;
    inputPayload?: import('@prisma/client').Prisma.InputJsonValue;
    outputPayload?: import('@prisma/client').Prisma.InputJsonValue;
    errorMessage?: string;
  }) {
    try {
      await this.prisma.llmAuditLog.create({ data });
    } catch (err) {
      this.logger.error('Failed to create audit log', err);
    }
  }
}

// ─── Top-level helper used by LlmService.fetchGeminiModels ────────────────────

function prettifyGeminiLabel(name: string): string {
  // Build a friendly label from the raw model id. Keeps the id visible as a
  // suffix so teachers can map back to docs.
  const isPreview = /preview/.test(name);
  const isLatest = /latest/.test(name);

  // e.g. gemini-2.5-pro-preview-tts → "Gemini 2.5 Pro (preview)"
  let pretty = name
    .replace(/^gemini-/, 'Gemini ')
    .replace(/-/g, ' ')
    .replace(/\bpro\b/i, 'Pro')
    .replace(/\bflash\b/i, 'Flash')
    .replace(/\blite\b/i, 'Lite')
    .replace(/\blatest\b/i, 'Latest')
    .replace(/\bpreview\b/i, '')
    .trim()
    .replace(/\s+/g, ' ');

  const tags: string[] = [];
  if (isPreview) tags.push('preview');
  if (isLatest) tags.push('auto-updates');
  if (tags.length) pretty += ` (${tags.join(', ')})`;
  return pretty;
}
