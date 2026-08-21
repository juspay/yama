import {
  applyHumanComments,
  applyYamaOutcomes,
  computePrecision,
  triageSchema,
} from "../../../src/v4/learn/Triage.js";
import { TRIAGE_INSTRUCTION } from "../../../src/v4/prompts/local.js";
import type {
  CommentClassification,
  RuleEntry,
  TriagedHumanComment,
  TriagedYamaComment,
  YamaCommentOutcome,
} from "../../../src/v4/types/index.js";

/**
 * Three places have to agree on the same words: the schema the model answers
 * against, the prompt that asks for them, and the code that matches on them.
 *
 * They drifted apart once. The schema asked for "convention" while `Triage.ts`
 * tested for "missed-convention", and a cast to the declared type hid the
 * mismatch from the compiler — so every human comment fell through to a no-op
 * and measured precision was permanently zero, with nothing anywhere reporting
 * a problem. These tests exist so that can only ever be a red build.
 */
describe("the triage vocabulary is one vocabulary", () => {
  const CLASSIFICATIONS: CommentClassification[] = [
    "missed-convention",
    "missed-bug",
    "preference",
    "context-specific",
  ];

  const OUTCOMES: YamaCommentOutcome[] = [
    "acted-on",
    "dismissed-no-change",
    "argued-down",
    "unresolved",
  ];

  it.each(CLASSIFICATIONS)(
    "the schema accepts the declared classification %s",
    (classification) => {
      const parsed = triageSchema.safeParse({
        human: [
          {
            classification,
            conventionKey: "k",
            title: "t",
            summary: "s",
          },
        ],
        yama: [],
      });
      expect(parsed.success).toBe(true);
    },
  );

  it.each(OUTCOMES)("the schema accepts the declared outcome %s", (outcome) => {
    const parsed = triageSchema.safeParse({
      human: [],
      yama: [{ findingId: "f1", outcome, title: "t" }],
    });
    expect(parsed.success).toBe(true);
  });

  it("rejects the words the schema used to ask for", () => {
    // The exact drift that broke learning. If someone reintroduces it, this
    // fails rather than silently zeroing every measurement.
    for (const stale of ["convention", "praise", "question"]) {
      expect(
        triageSchema.safeParse({
          human: [
            {
              classification: stale,
              conventionKey: "k",
              title: "t",
              summary: "s",
            },
          ],
          yama: [],
        }).success,
      ).toBe(false);
    }

    for (const stale of ["fixed", "acknowledged", "unknown"]) {
      expect(
        triageSchema.safeParse({
          human: [],
          yama: [{ findingId: "f", outcome: stale, title: "t" }],
        }).success,
      ).toBe(false);
    }
  });

  it("asks the model for exactly the words it matches on", () => {
    for (const word of [...CLASSIFICATIONS, ...OUTCOMES]) {
      expect(TRIAGE_INSTRUCTION).toContain(`"${word}"`);
    }
  });

  it("parses a schema-valid response straight into the triaged types", () => {
    const parsed = triageSchema.parse({
      human: [
        {
          classification: "missed-convention",
          conventionKey: "input-validation",
          title: "Validate at the boundary",
          summary: "Every handler validates its input.",
        },
      ],
      yama: [{ findingId: "f1", outcome: "acted-on", title: "t" }],
    });

    // No cast: these assignments are the compile-time guarantee that the
    // schema and the declared types describe the same shape.
    const human: TriagedHumanComment[] = parsed.human;
    const yama: TriagedYamaComment[] = parsed.yama;

    expect(human[0].classification).toBe("missed-convention");
    expect(yama[0].outcome).toBe("acted-on");
  });
});

describe("what the aligned vocabulary makes work again", () => {
  it("promotes a convention a human stated", () => {
    const comment: TriagedHumanComment = {
      classification: "missed-convention",
      conventionKey: "input-validation",
      title: "Validate at the boundary",
      summary: "Every handler validates its input.",
    };

    const first = applyHumanComments([], [comment], 1);
    expect(first.rules).toHaveLength(1);
    expect(first.changes.join(" ")).not.toBe("");

    // Second independent sighting: conventions promote at one or two.
    const second = applyHumanComments(first.rules, [comment], 2);
    const rule = second.rules[0] as RuleEntry;
    expect(rule.occurrences).toBeGreaterThanOrEqual(2);
    expect(rule.status).toBe("active");
  });

  it("measures precision from what authors actually did", () => {
    // This returned 0 for every run while the vocabularies disagreed.
    const precision = computePrecision([
      { findingId: "a", outcome: "acted-on", title: "t" },
      { findingId: "b", outcome: "acted-on", title: "t" },
      { findingId: "c", outcome: "dismissed-no-change", title: "t" },
    ]);
    expect(precision.actedOn).toBe(2);
    expect(precision.dismissed).toBe(1);
  });

  it("only treats a repeatedly dismissed finding as a suppression candidate", () => {
    const dismissed: TriagedYamaComment = {
      findingId: "noisy",
      outcome: "dismissed-no-change",
      title: "Prefer const",
    };

    let rules: RuleEntry[] = [];
    for (let pullRequest = 1; pullRequest <= 3; pullRequest += 1) {
      rules = applyYamaOutcomes(rules, [dismissed], pullRequest).rules;
    }

    // Suppression is deliberately slower than promotion: learning to stay quiet
    // about a real defect is the more expensive mistake.
    expect(rules.length).toBeGreaterThan(0);
  });
});
