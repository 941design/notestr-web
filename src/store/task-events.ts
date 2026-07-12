/**
 * task-events.ts (src/store) — pure re-export shim.
 *
 * S2 TaskEvent relocation (DECIDER GATE, S1 review cycle): the canonical
 * definition of TaskEvent — the pure inner-core domain wire type — now lives
 * in src/domain/task-events.ts (architecture.md: "the pure inner core owns
 * the domain wire type"). This file re-exports it verbatim so every existing
 * importer (src/marmot/, src/components/, src/store/, src/types/, e2e/) keeps
 * working unchanged with zero call-site edits.
 *
 * Do NOT add new declarations here — add them to src/domain/task-events.ts;
 * they flow through this re-export automatically.
 */
export * from "../domain/task-events";
