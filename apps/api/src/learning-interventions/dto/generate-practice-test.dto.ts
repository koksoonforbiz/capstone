export interface GeneratePracticeTestDto {
  /** Either `selectedText` (≥20 chars) OR no selection — when empty,
   *  the server falls back to RAG over the course's uploaded materials. */
  selectedText: string;
  courseId: string;
  contentId?: string;
  pageType?: string;
  /** Optional topic hint to bias the RAG fallback when no text is
   *  selected. If absent, the service derives one from `contentId`. */
  topic?: string;
  questionCount?: number; // default 5, min 1, max 10
}

export interface SubmitPracticeTestAnswersDto {
  answers: Array<{
    questionIndex: number;
    answer: string;
  }>;
}
