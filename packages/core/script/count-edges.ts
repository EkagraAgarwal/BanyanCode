import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "../src/database/database"

import { sql } from "drizzle-orm"

const CountEdgesProgram = Effect.gen(function* () {
  const { db } = yield* Database.Service

  const rows = yield* db.all<{ kind: string, c: number }>(sql`
    SELECT kind, COUNT(*) as c 
    FROM codegraph_edges 
    GROUP BY kind 
    ORDER BY c DESC
  `).pipe(Effect.orDie)

  console.log("Edge breakdown by kind:")
  console.table(rows)
})

const runtime = ManagedRuntime.make(Database.defaultLayer)
runtime.runPromise(CountEdgesProgram).catch(console.error)
