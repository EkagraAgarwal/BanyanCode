/**
 * Optional-schema helpers, ported from v1 `src/tool/tool-schema.ts`.
 *
 * Effect v4 decodes a missing optional or a JSON `null` the same way here:
 * v1 needed a `NullOr` → `UndefinedOr` transform because the tool input
 * decoder emitted `null` for absent fields. The v2 `Tool.Info` input schema
 * is consumed by the same Schema decoder, so the transform is kept to keep
 * parameter shapes identical.
 */
import { Schema, SchemaTransformation } from "effect"

const nullToUndef = <A>(from: A) => (from ?? undefined) as A | undefined
const undefToNull = <A>(from: A) => (from ?? null) as A | null

const fromNullOr = <S extends Schema.Top>(s: S) =>
  Schema.NullOr(s).pipe(
    Schema.decodeTo(
      Schema.UndefinedOr(s),
      SchemaTransformation.transform({ decode: nullToUndef, encode: undefToNull }),
    ),
  )

export const optionalString = Schema.optional(fromNullOr(Schema.String))
export const optionalNumber = Schema.optional(fromNullOr(Schema.Number))
export const optionalBoolean = Schema.optional(fromNullOr(Schema.Boolean))
