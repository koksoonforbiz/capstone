import {
  Controller,
  Get,
  Post,
  Put,
  Delete,
  Query,
  Param,
  Body,
  Request,
  UseGuards,
  Res,
} from '@nestjs/common';
import type { Response } from 'express';
import { JwtAuthGuard, Roles, RolesGuard } from '../auth';
import { UserManagementService } from './user-management.service';

interface RequestUser {
  id: string;
  email: string;
  name: string;
  role: string;
}

@Controller('user-management')
@UseGuards(JwtAuthGuard, RolesGuard)
export class UserManagementController {
  constructor(private readonly service: UserManagementService) {}

  // ─── Students ─────────────────────────────────────────

  @Get('students')
  @Roles('teacher', 'admin')
  async getStudents(
    @Request() req: { user: RequestUser },
    @Query('courseId') courseId?: string,
    @Query('search') search?: string,
    @Query('page') page?: string,
    @Query('limit') limit?: string,
    @Query('sortBy') sortBy?: string,
    @Query('sortOrder') sortOrder?: string,
  ) {
    return this.service.getStudents(req.user.id, {
      courseId,
      search,
      page: page ? parseInt(page, 10) : undefined,
      limit: limit ? parseInt(limit, 10) : undefined,
      sortBy: sortBy as 'name' | 'lastActive' | 'cost' | 'joinedAt',
      sortOrder: sortOrder as 'asc' | 'desc',
    });
  }

  @Get('students/export')
  @Roles('teacher', 'admin')
  async exportStudents(
    @Request() req: { user: RequestUser },
    @Query('courseId') courseId?: string,
    @Res() res?: Response,
  ) {
    const csv = await this.service.exportStudentsCsv(req.user.id, courseId);
    res!.setHeader('Content-Type', 'text/csv');
    res!.setHeader('Content-Disposition', 'attachment; filename=students.csv');
    res!.send(csv);
  }

  @Get('students/:studentId')
  @Roles('teacher', 'admin')
  async getStudentDetail(
    @Request() req: { user: RequestUser },
    @Param('studentId') studentId: string,
  ) {
    return this.service.getStudentDetail(req.user.id, studentId);
  }

  @Post('students')
  @Roles('teacher', 'admin')
  async addStudent(
    @Request() req: { user: RequestUser },
    @Body() body: { name: string; email: string; courseIds: string[] },
  ) {
    return this.service.addStudent(req.user.id, body);
  }

  @Post('students/bulk')
  @Roles('teacher', 'admin')
  async bulkAddStudents(
    @Request() req: { user: RequestUser },
    @Body() body: { students: Array<{ email: string; name: string }>; courseIds: string[] },
  ) {
    return this.service.bulkAddStudents(req.user.id, body);
  }

  @Post('students/:studentId/resend-invitation')
  @Roles('teacher', 'admin')
  async resendInvitation(
    @Request() req: { user: RequestUser },
    @Param('studentId') studentId: string,
  ) {
    return this.service.resendInvitation(req.user.id, studentId);
  }

  /**
   * Hard-delete a student account and all of their data.
   *
   * Authorization:
   *   - Admin: may delete any student.
   *   - Teacher: may delete a student only if the student is enrolled in
   *     at least one course the teacher owns. (Same scoping rule as the
   *     other student-management endpoints.)
   *
   * The endpoint refuses to operate on non-student accounts — this is a
   * student-cleanup tool, not a generic user deletion. Admin accounts
   * and teacher accounts must be removed through a separate flow.
   *
   * The body of the response lists the row counts removed per table so
   * the UI can show an audit summary. The deletion is wrapped in a
   * single Postgres transaction; any constraint failure rolls back the
   * whole thing and the student remains intact.
   */
  @Delete('students/:studentId')
  @Roles('teacher', 'admin')
  async deleteStudent(
    @Request() req: { user: RequestUser },
    @Param('studentId') studentId: string,
  ) {
    return this.service.deleteStudent(req.user.id, req.user.role, studentId);
  }

  // ─── Teacher Usage ────────────────────────────────────

  @Get('my-usage')
  @Roles('teacher', 'admin')
  async getMyUsage(
    @Request() req: { user: RequestUser },
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.getTeacherUsage(req.user.id, dateFrom, dateTo);
  }

  // ─── Course Usage ─────────────────────────────────────

  @Get('courses-overview')
  @Roles('teacher', 'admin')
  async getCoursesOverview(@Request() req: { user: RequestUser }) {
    return this.service.getCoursesOverview(req.user.id);
  }

  @Get('usage-summary')
  @Roles('teacher', 'admin')
  async getCourseUsageSummary(
    @Request() req: { user: RequestUser },
    @Query('courseId') courseId: string,
    @Query('dateFrom') dateFrom?: string,
    @Query('dateTo') dateTo?: string,
  ) {
    return this.service.getCourseUsageSummary(req.user.id, courseId, dateFrom, dateTo);
  }

  // ─── Pricing ──────────────────────────────────────────

  @Get('pricing')
  @Roles('teacher', 'admin')
  async getPricing() {
    return this.service.getPricing();
  }

  @Put('pricing/:id')
  @Roles('admin')
  async updatePricing(
    @Param('id') id: string,
    @Body() body: { inputPricePer1k: number; outputPricePer1k: number },
  ) {
    return this.service.updatePricing(id, body);
  }
}
