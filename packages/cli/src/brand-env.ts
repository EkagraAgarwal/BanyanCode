// Side-effect entry module: imported first by `index.ts` so the environment is
// rewritten before any other module evaluates and captures process.env.
import { EnvMap } from "./env-map"

EnvMap.apply(process.env)
