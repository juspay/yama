/**
 * Parser naming.
 *
 * An alias of {@link CheckParser} rather than `keyof typeof PARSERS`: a type
 * derived from a runtime value cannot live in the types folder without dragging
 * the value along, and the union is already declared with the check config.
 */

import type { CheckParser } from "./config.js";

export type ParserName = CheckParser;
