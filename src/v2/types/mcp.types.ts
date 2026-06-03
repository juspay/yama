/**
 * MCP (Model Context Protocol) response type definitions.
 *
 * These describe the shapes Yama reads back from VCS MCP tool calls
 * (Bitbucket / GitHub pull requests, diffs, code search, Jira issues).
 *
 * The fictional `NeuroLinkAPI`/`callTool` interface and the unused
 * server-management helper types were removed when the dead VCSProvider
 * classes were deleted — only these still-used response shapes (re-exported
 * from src/index.ts) remain.
 */

/**
 * Bitbucket/GitHub Pull Request response from a PR-read tool call
 */
export interface GetPullRequestResponse {
  id?: number | string;
  number?: number;
  title?: string;
  description?: string;
  // Permissive to preserve Bitbucket/GitHub parity: callers may compare
  // historical/raw provider states in any casing (e.g. "OPEN", "MERGED").
  state?: string;
  source?: {
    branch?: {
      name?: string;
    };
    repository?: {
      full_slug?: string;
    };
  };
  destination?: {
    branch?: {
      name?: string;
    };
    repository?: {
      full_slug?: string;
    };
  };
  head?: {
    ref?: string;
  };
  base?: {
    ref?: string;
  };
  user?: {
    login?: string;
  };
  author?: {
    username?: string;
  };
  created_on?: string;
  createdAt?: string;
  updated_on?: string;
  updatedAt?: string;
  links?: {
    html?: {
      href?: string;
    };
  };
  html_url?: string;
  [key: string]: unknown;
}

/**
 * Pull request diff response from a diff-read tool call
 */
export interface GetPullRequestDiffResponse {
  diffs?: Array<{
    source?: {
      path?: string;
    };
    destination?: {
      path?: string;
    };
    lines?: Array<{
      type?: string;
      content?: string;
      line_number?: number;
      old_line_number?: number;
    }>;
  }>;
  files?: Array<{
    filename?: string;
    patch?: string;
    changes?: number;
    additions?: number;
    deletions?: number;
  }>;
  [key: string]: unknown;
}

/**
 * Jira issue response from an issue-read tool call
 */
export interface GetIssueResponse {
  key?: string;
  id?: string;
  fields?: {
    summary?: string;
    description?: string;
    status?: {
      name?: string;
    };
    issuetype?: {
      name?: string;
    };
    [key: string]: unknown;
  };
  [key: string]: unknown;
}

/**
 * Code search response from a code-search tool call
 */
export interface SearchCodeResponse {
  results?: Array<{
    file?: {
      path?: string;
    };
    path?: string;
    lines?: Array<{
      content?: string;
      line_number?: number;
    }>;
    content?: string;
  }>;
  [key: string]: unknown;
}
