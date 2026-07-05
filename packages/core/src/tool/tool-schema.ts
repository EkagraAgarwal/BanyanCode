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
