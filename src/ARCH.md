# Runtime modules

values.ts defines comparison semantics; query.ts compiles safe field access, filters and ordering descriptors. normalize.ts validates table/tree state. dataview.ts and tree.ts implement synchronous grid execution. identity.ts owns JSON identifier canonicalization. data-patch.ts and view-meta.ts are immutable update helpers.

stream.ts is a focused public entry; stream/ implements source execution. adapters/ contains structural integrations. Keep runtime modules platform-independent and package-dependency-free. Share query semantics across array and stream execution rather than duplicating predicate logic.

flat-page.ts selects stable shallow prefixes, sampling matching rows for a native reverse-run fallback. fields.ts/query.ts specialize arities 2..4 without changing own-property or short-circuit semantics.

query-internals.ts privately shares captured operands and value comparison with optional source acceleration; it is not a public cache-trust flag.
