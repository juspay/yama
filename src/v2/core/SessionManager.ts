/**
 * Session Manager for Yama V2
 * Tracks review sessions, tool calls, and maintains state
 */

import { randomBytes } from "crypto";
import {
  ReviewSession,
  ReviewRequest,
  ReviewResult,
  ToolCallRecord,
  SessionMetadata,
} from "../types/v2.types.js";

export class SessionManager {
  private sessions: Map<string, ReviewSession> = new Map();
  private maxSessions: number = 100;

  /**
   * Create a new review session
   */
  createSession(request: ReviewRequest): string {
    const sessionId = this.generateSessionId();

    const session: ReviewSession = {
      sessionId,
      request,
      startTime: new Date(),
      status: "running",
      toolCalls: [],
      metadata: {
        yamaVersion: "2.0.0",
        aiProvider: "auto",
        aiModel: "unknown",
        totalTokens: 0,
        totalCost: 0,
        cacheHitRatio: 0,
      },
    };

    this.sessions.set(sessionId, session);

    // Clean up old sessions if we exceed max
    if (this.sessions.size > this.maxSessions) {
      this.cleanupOldSessions();
    }

    return sessionId;
  }

  /**
   * Get session by ID
   */
  getSession(sessionId: string): ReviewSession {
    const session = this.sessions.get(sessionId);
    if (!session) {
      throw new Error(`Session not found: ${sessionId}`);
    }
    return session;
  }

  /**
   * Record a tool call in the session
   */
  recordToolCall(
    sessionId: string,
    toolName: string,
    args: any,
    result: any,
    duration: number,
    error?: string,
  ): void {
    const session = this.getSession(sessionId);

    const toolCall: ToolCallRecord = {
      timestamp: new Date(),
      toolName,
      args,
      result,
      error,
      duration,
    };

    session.toolCalls.push(toolCall);
  }

  /**
   * Update session metadata
   */
  updateMetadata(sessionId: string, updates: Partial<SessionMetadata>): void {
    const session = this.getSession(sessionId);
    session.metadata = {
      ...session.metadata,
      ...updates,
    };
  }

  /**
   * Mark session as completed
   */
  completeSession(sessionId: string, result: ReviewResult): void {
    const session = this.getSession(sessionId);
    session.status = "completed";
    session.endTime = new Date();
    session.result = result;
  }

  /**
   * Mark session as failed
   */
  failSession(sessionId: string, error: Error): void {
    const session = this.getSession(sessionId);
    session.status = "failed";
    session.endTime = new Date();
    session.error = error;
  }

  /**
   * Get all active sessions
   */
  getActiveSessions(): ReviewSession[] {
    return Array.from(this.sessions.values()).filter(
      (s) => s.status === "running",
    );
  }

  /**
   * Get session statistics
   */
  getSessionStats(sessionId: string): {
    duration: number;
    toolCallCount: number;
    uniqueTools: number;
    averageToolCallDuration: number;
    toolCallsByName: Record<string, number>;
  } {
    const session = this.getSession(sessionId);
    const duration = session.endTime
      ? session.endTime.getTime() - session.startTime.getTime()
      : Date.now() - session.startTime.getTime();

    const toolCallsByName: Record<string, number> = {};
    let totalToolDuration = 0;

    session.toolCalls.forEach((tc) => {
      toolCallsByName[tc.toolName] = (toolCallsByName[tc.toolName] || 0) + 1;
      totalToolDuration += tc.duration;
    });

    return {
      duration: Math.round(duration / 1000), // seconds
      toolCallCount: session.toolCalls.length,
      uniqueTools: Object.keys(toolCallsByName).length,
      averageToolCallDuration:
        session.toolCalls.length > 0
          ? Math.round(totalToolDuration / session.toolCalls.length)
          : 0,
      toolCallsByName,
    };
  }

  /**
   * Generate unique session ID
   */
  private generateSessionId(): string {
    const timestamp = Date.now().toString(36);
    const random = randomBytes(4).toString("hex");
    return `yama-v2-${timestamp}-${random}`;
  }

  /**
   * Clean up old sessions (keep most recent 100)
   */
  private cleanupOldSessions(): void {
    const sessions = Array.from(this.sessions.entries());

    // Sort by start time (oldest first)
    sessions.sort((a, b) => {
      return a[1].startTime.getTime() - b[1].startTime.getTime();
    });

    // Remove oldest sessions
    const toRemove = sessions.length - this.maxSessions;
    for (let i = 0; i < toRemove; i++) {
      this.sessions.delete(sessions[i][0]);
    }
  }

  /**
   * Export session data for debugging
   */
  exportSession(sessionId: string): any {
    const session = this.getSession(sessionId);
    const stats = this.getSessionStats(sessionId);

    return {
      session: {
        sessionId: session.sessionId,
        request: session.request,
        startTime: session.startTime.toISOString(),
        endTime: session.endTime?.toISOString(),
        status: session.status,
        metadata: session.metadata,
        result: session.result,
        error: session.error?.message,
      },
      statistics: stats,
      toolCalls: session.toolCalls.map((tc) => ({
        timestamp: tc.timestamp.toISOString(),
        toolName: tc.toolName,
        args: tc.args,
        duration: tc.duration,
        error: tc.error,
        // Don't include full result in export (can be very large)
        resultSummary: this.summarizeToolResult(tc.result),
      })),
    };
  }

  /**
   * Summarize tool result for logging
   */
  private summarizeToolResult(result: any): string {
    if (!result) {
      return "null";
    }
    if (typeof result === "string") {
      return result.length > 100 ? `${result.substring(0, 100)}...` : result;
    }
    if (typeof result === "object") {
      const keys = Object.keys(result);
      return `{${keys.slice(0, 5).join(", ")}${keys.length > 5 ? ", ..." : ""}}`;
    }
    return String(result);
  }

  /**
   * Clear all sessions
   */
  clearAll(): void {
    this.sessions.clear();
  }

  /**
   * Get session count
   */
  getSessionCount(): number {
    return this.sessions.size;
  }
}
