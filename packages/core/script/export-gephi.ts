import { Effect, Layer, ManagedRuntime } from "effect"
import { Database } from "../src/database/database"
import { CodegraphRepo } from "../src/banyancode/codegraph-repo"
import { writeFileSync } from "fs"
import path from "path"

const ExportProgram = Effect.gen(function* () {
  const repo = yield* CodegraphRepo.Service

  console.log("Fetching nodes...")
  const nodes = yield* repo.listAllNodes()
  
  console.log("Fetching edges...")
  const edges = yield* repo.listAllEdges()

  console.log(`Exporting ${nodes.length} nodes and ${edges.length} edges...`)

  // Gephi Nodes CSV Format: Id, Label, Kind
  let nodesCsv = "Id,Label,Kind,FileID\n"
  for (const node of nodes) {
    // Escape quotes for CSV
    const label = (node.name ?? "unnamed").replace(/"/g, '""')
    nodesCsv += `"${node.id}","${label}","${node.kind}","${node.fileID}"\n`
  }
  
  const nodesPath = path.resolve(process.cwd(), "codegraph_nodes.csv")
  writeFileSync(nodesPath, nodesCsv, "utf-8")
  console.log(`Saved nodes to ${nodesPath}`)

  // Gephi Edges CSV Format: Source, Target, Type
  let edgesCsv = "Source,Target,Type,Id\n"
  for (const edge of edges) {
    edgesCsv += `"${edge.fromNodeID}","${edge.toNodeID}","${edge.kind}","${edge.id}"\n`
  }
  
  const edgesPath = path.resolve(process.cwd(), "codegraph_edges.csv")
  writeFileSync(edgesPath, edgesCsv, "utf-8")
  console.log(`Saved edges to ${edgesPath}`)

  console.log("Export complete! You can import these CSVs into Gephi.")
})

const MainLayer = Layer.mergeAll(
  Database.defaultLayer,
  CodegraphRepo.defaultLayer
)

const runtime = ManagedRuntime.make(MainLayer)

runtime.runPromise(ExportProgram).catch(console.error)
