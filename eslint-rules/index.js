/**
 * Yama's custom ESLint plugin — NeuroLink's type-engineering rulings, retargeted
 * onto Yama's `src/types/` layout (NeuroLink uses `src/lib/types/`).
 *
 * Rules that need a filesystem path or cross-file state live here; the rest of
 * the rulings are expressed as `no-restricted-syntax` selectors in
 * eslint.config.js, which names each one and why. See ../eslint.config.js.
 *
 *   yama/no-types-suffix-filename    Rule 8  — no "Types"/"Type" suffix in src/types/ filenames
 *   yama/unique-type-names           Rule 9  — exported names unique across src/types/
 *   yama/no-local-types-folder       Rule 11 — no types/ folder or types.ts outside src/types/
 *   yama/no-type-export-outside-types Rule 12 — no type definitions/re-exports outside src/types/
 *   yama/barrel-type-imports         Rule 13 — internal types imported from the barrel only
 */

import barrelTypeImports from "./barrel-type-imports.js";
import noLocalTypesFolder from "./no-local-types-folder.js";
import noTypeExportOutsideTypes from "./no-type-export-outside-types.js";
import noTypesSuffixFilename from "./no-types-suffix-filename.js";
import uniqueTypeNames from "./unique-type-names.js";

export default {
  meta: { name: "eslint-plugin-yama", version: "0.0.0" },
  rules: {
    "barrel-type-imports": barrelTypeImports,
    "no-local-types-folder": noLocalTypesFolder,
    "no-type-export-outside-types": noTypeExportOutsideTypes,
    "no-types-suffix-filename": noTypesSuffixFilename,
    "unique-type-names": uniqueTypeNames,
  },
};
