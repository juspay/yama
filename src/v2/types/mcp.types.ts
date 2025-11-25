/**
 * MCP Tool Response Type Definitions
 * Types for Bitbucket and Jira MCP tool responses
 */

// ============================================================================
// MCP Server Status Types
// ============================================================================

export interface MCPStatus {
  totalServers: number;
  totalTools: number;
  servers: MCPServerStatus[];
}

export interface MCPServerStatus {
  id: string;
  connected: boolean;
  tools: string[];
  lastHealthCheck?: Date;
  error?: string;
}

// ============================================================================
// Bitbucket MCP Tool Response Types
// ============================================================================

export interface GetPullRequestResponse {
  id: number;
  title: string;
  description: string;
  author: {
    name: string;
    displayName: string;
    emailAddress?: string;
  };
  state: "OPEN" | "MERGED" | "DECLINED";
  source: {
    branch: { name: string };
    commit: { id: string };
  };
  destination: {
    branch: { name: string };
    commit: { id: string };
  };
  createdDate: string;
  updatedDate: string;
  reviewers: Reviewer[];
  active_comments?: Comment[];
  file_changes?: FileChange[];
}

export interface Reviewer {
  user: {
    name: string;
    displayName: string;
    emailAddress?: string;
  };
  approved: boolean;
  status: "APPROVED" | "UNAPPROVED" | "NEEDS_WORK";
}

export interface Comment {
  id: number;
  text: string;
  author: {
    name: string;
    displayName: string;
  };
  createdDate: string;
  updatedDate: string;
  anchor?: CommentAnchor;
}

export interface CommentAnchor {
  filePath: string;
  lineFrom: number;
  lineTo: number;
  lineType: "ADDED" | "REMOVED" | "CONTEXT";
}

export interface FileChange {
  path: string;
  file?: string;
  type: "ADD" | "MODIFY" | "DELETE" | "RENAME";
}

export interface GetPullRequestDiffResponse {
  diff: string;
  file_changes?: FileChange[];
  additions?: number;
  deletions?: number;
}

export interface AddCommentRequest {
  workspace: string;
  repository: string;
  pull_request_id: number;
  comment_text: string;
  file_path?: string;
  code_snippet?: string;
  line_number?: number;
  line_type?: "ADDED" | "REMOVED" | "CONTEXT";
  parent_comment_id?: number;
}

export interface AddCommentResponse {
  id: number;
  text: string;
  author: string;
  createdDate: string;
  anchor?: CommentAnchor;
}

export interface UpdatePullRequestRequest {
  workspace: string;
  repository: string;
  pull_request_id: number;
  title?: string;
  description?: string;
  reviewers?: string[];
}

export interface GetFileContentResponse {
  content: string;
  path: string;
  size: number;
  encoding?: string;
}

export interface ListDirectoryContentResponse {
  path: string;
  items: DirectoryItem[];
}

export interface DirectoryItem {
  type: "file" | "directory";
  path: string;
  name: string;
  size?: number;
}

export interface SearchCodeResponse {
  results: SearchResult[];
  totalCount: number;
}

export interface SearchResult {
  file: string;
  line: number;
  content: string;
  matches: string[];
}

// ============================================================================
// Jira MCP Tool Response Types
// ============================================================================

export interface GetIssueResponse {
  key: string;
  id: string;
  summary: string;
  description: string;
  status: {
    name: string;
    category: string;
  };
  issueType: {
    name: string;
    description: string;
  };
  priority: {
    name: string;
  };
  assignee?: {
    displayName: string;
    emailAddress: string;
  };
  reporter: {
    displayName: string;
    emailAddress: string;
  };
  created: string;
  updated: string;
  customFields?: Record<string, any>;
}

export interface SearchIssuesRequest {
  jql: string;
  maxResults?: number;
  startAt?: number;
}

export interface SearchIssuesResponse {
  issues: GetIssueResponse[];
  total: number;
  startAt: number;
  maxResults: number;
}

export interface GetIssueCommentsResponse {
  comments: JiraComment[];
  total: number;
}

export interface JiraComment {
  id: string;
  author: {
    displayName: string;
    emailAddress: string;
  };
  body: string;
  created: string;
  updated: string;
}
