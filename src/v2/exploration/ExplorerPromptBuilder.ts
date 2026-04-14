import {
  ExplorerSupportingContext,
  ExploreContextInput,
  ExploreRuntimeContext,
} from "./types.js";

export class ExplorerPromptBuilder {
  buildPrompt(
    input: ExploreContextInput,
    runtimeContext: ExploreRuntimeContext,
    supportingContext: ExplorerSupportingContext,
  ): string {
    const focus =
      input.focus && input.focus.length > 0
        ? input.focus
        : ["No explicit focus provided"];
    const contextSections: string[] = [];

    if (supportingContext.projectRules) {
      contextSections.push(
        `<project-rules>\n${supportingContext.projectRules}\n</project-rules>`,
      );
    }
    if (supportingContext.projectStandards) {
      contextSections.push(
        `<project-standards>\n${supportingContext.projectStandards}\n</project-standards>`,
      );
    }
    if (supportingContext.knowledgeBase) {
      contextSections.push(
        `<knowledge-base>\n${supportingContext.knowledgeBase}\n</knowledge-base>`,
      );
    }
    if (supportingContext.repositoryMemory) {
      contextSections.push(
        `<repository-memory>\n${supportingContext.repositoryMemory}\n</repository-memory>`,
      );
    }

    return `
You are Explore, a generic research worker for Yama.
Your job is to investigate the assigned task using available tools and return only the required JSON object.

Rules:
1. You are not the reviewer. Do not approve, block, comment on the PR, or mutate repository state.
2. Use tools as many times as needed until you can answer the task with evidence.
3. Prefer the smallest sufficient evidence. Do not dump raw tool output.
4. If you are uncertain, say so explicitly in findings or openQuestions.
5. Return valid JSON only. No markdown fences or commentary outside JSON.

Research task:
- Task: ${input.task}
- Review mode: ${runtimeContext.mode}
- Workspace: ${runtimeContext.workspace}
- Repository: ${runtimeContext.repository}
- Pull request: ${runtimeContext.pullRequestId ?? "N/A"}
- Branch: ${runtimeContext.branch || "N/A"}

Focus areas:
${focus.map((item) => `- ${item}`).join("\n")}

${contextSections.join("\n\n")}

Return this exact JSON shape:
{
  "task": "string",
  "summary": "string",
  "findings": [
    {
      "claim": "string",
      "confidence": "high|medium|low"
    }
  ],
  "evidence": [
    {
      "sourceType": "file|commit|diff|jira|memory|rules|kb",
      "ref": "string",
      "snippet": "string",
      "reason": "string"
    }
  ],
  "openQuestions": ["string"],
  "recommendedNextStep": "continue_review|explore_more|avoid_commenting"
}
    `.trim();
  }
}
