import type { Argv } from "yargs"
import { Effect } from "effect"
import { Banyan } from "@opencode-ai/core/banyancode"
import { effectCmd } from "../effect-cmd"
import { UI } from "../ui"

const dim = (value: string) => UI.Style.TEXT_DIM + value + UI.Style.TEXT_NORMAL

const goalServiceLayer = Banyan.goalServiceDefaultLayer

const SetCommand = effectCmd({
  command: "set <condition>",
  describe: "create a new active goal for the current session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .positional("condition", { type: "string", demandOption: true, describe: "goal condition (free-text)" })
      .option("plan", { type: "string", describe: "path to plan.md (defaults to ./plan.md)" })
      .option("priority", { type: "string", default: "normal", choices: ["low", "normal", "high"] })
      .option("session", { type: "string", describe: "session id (defaults to the active session)", demandOption: true }),
  handler: Effect.fn("Cli.goal.set")(function* (args: { condition: string; plan?: string; priority?: string; session: string }) {
    return yield* Effect.gen(function* () {
      const svc = yield* Banyan.GoalService
      const goal = yield* svc
        .setGoal({
          parentSessionID: args.session,
          condition: args.condition,
          planPath: args.plan ?? "./plan.md",
          priority: (args.priority ?? "normal") as "low" | "normal" | "high",
        })
        .pipe(
          Effect.catchTag("Banyan/GoalConflictError", (e: Banyan.GoalConflictError) =>
            Effect.fail({
              message: `an active goal already exists: ${e.existingGoalID}. Run \`banyancode goal cancel\` first.`,
            }),
          ),
        )
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ goal set" + UI.Style.TEXT_NORMAL)
      UI.println(dim(`  id:        ${goal.id}`))
      UI.println(dim(`  condition: ${goal.condition.slice(0, 80)}${goal.condition.length > 80 ? "…" : ""}`))
      UI.println(dim(`  plan:      ${goal.planPath ?? "(none)"}`))
      UI.println(dim(`  priority:  ${goal.priority ?? "(default)"}`))
    }).pipe(Effect.provide(goalServiceLayer), Effect.mapError((e) => e as never))
  }),
})

const StatusCommand = effectCmd({
  command: "status",
  describe: "print the active goal for a session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("session", { type: "string", demandOption: true, describe: "session id" }),
  handler: Effect.fn("Cli.goal.status")(function* (args: { session: string }) {
    return yield* Effect.gen(function* () {
      const svc = yield* Banyan.GoalService
      const goal = yield* svc.getActiveGoal(args.session)
      if (!goal) {
        UI.println(dim(`no active goal for session ${args.session}`))
        return
      }
      UI.println(UI.Style.TEXT_HIGHLIGHT + `Active goal: ${goal.id}` + UI.Style.TEXT_NORMAL)
      UI.println(dim(`  condition:     ${goal.condition}`))
      UI.println(dim(`  plan:          ${goal.planPath ?? "(none)"}`))
      UI.println(dim(`  priority:      ${goal.priority ?? "(default)"}`))
      UI.println(dim(`  iteration:     ${goal.iterationCount}`))
      UI.println(dim(`  last verdict:  ${goal.lastReviewVerdict ?? "(none)"}`))
      UI.println(dim(`  last reason:   ${goal.lastReviewReason ?? "(none)"}`))
      UI.println(dim(`  created:       ${new Date(goal.createdAt).toISOString()}`))
    }).pipe(Effect.provide(goalServiceLayer), Effect.mapError((e) => e as never))
  }),
})

const ListCommand = effectCmd({
  command: "list",
  describe: "list all goals (active + terminal) for a session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("session", { type: "string", demandOption: true, describe: "session id" }),
  handler: Effect.fn("Cli.goal.list")(function* (args: { session: string }) {
    return yield* Effect.gen(function* () {
      const svc = yield* Banyan.GoalService
      const goals = yield* svc.listGoals(args.session)
      UI.println(
        UI.Style.TEXT_HIGHLIGHT + `Goals for session ${args.session}: ${goals.length}` + UI.Style.TEXT_NORMAL,
      )
      for (const g of goals) {
        const cond = g.condition.length > 80 ? g.condition.slice(0, 80) + "…" : g.condition
        UI.println(
          `  ${UI.Style.TEXT_HIGHLIGHT}${g.id}${UI.Style.TEXT_NORMAL}  ${dim(
            `status=${g.status} iter=${g.iterationCount} verdict=${g.lastReviewVerdict ?? "(none)"}`,
          )}`,
        )
        UI.println(`    ${dim(cond)}`)
      }
    }).pipe(Effect.provide(goalServiceLayer), Effect.mapError((e) => e as never))
  }),
})

const CancelCommand = effectCmd({
  command: "cancel",
  describe: "cancel the active goal for a session",
  instance: false,
  builder: (yargs: Argv) =>
    yargs.option("session", { type: "string", demandOption: true, describe: "session id" }),
  handler: Effect.fn("Cli.goal.cancel")(function* (args: { session: string }) {
    return yield* Effect.gen(function* () {
      const svc = yield* Banyan.GoalService
      const active = yield* svc.getActiveGoal(args.session)
      if (!active) {
        UI.println(dim(`no active goal for session ${args.session}`))
        return
      }
      const updated = yield* svc.cancel(active.id, "user-cancelled-via-cli")
      UI.println(UI.Style.TEXT_SUCCESS_BOLD + "✓ goal cancelled" + UI.Style.TEXT_NORMAL + ` id=${updated.id}`)
    }).pipe(Effect.provide(goalServiceLayer), Effect.mapError((e) => e as never))
  }),
})

export const GoalCommand = effectCmd({
  command: "goal",
  describe: "manage /goal loop goals (set/status/list/cancel)",
  instance: false,
  builder: (yargs: Argv) =>
    yargs
      .command(SetCommand)
      .command(StatusCommand)
      .command(ListCommand)
      .command(CancelCommand)
      .demandCommand(),
  handler: Effect.fn("Cli.goal")(function* () {}),
})