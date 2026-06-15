import path from "path"
import fs from "fs/promises"
import { xdgData, xdgCache, xdgConfig, xdgState } from "xdg-basedir"
import os from "os"
import { Context, Effect, Layer } from "effect"
import { Flock } from "./util/flock"
import { Flag } from "./flag/flag"
import { LayerNode } from "./effect/layer-node"

const app = "opencode"
const data = path.join(xdgData!, app)
const cache = path.join(xdgCache!, app)
const config = path.join(xdgConfig!, app)
const state = path.join(xdgState!, app)
const tmp = path.join(os.tmpdir(), app)

const banyanApp = "banyancode"
const banyanData = path.join(xdgData!, banyanApp)
const banyanCache = path.join(xdgCache!, banyanApp)
const banyanConfig = path.join(xdgConfig!, banyanApp)
const banyanState = path.join(xdgState!, banyanApp)
const banyanTmp = path.join(os.tmpdir(), banyanApp)

const paths = {
  get home() {
    return process.env.OPENCODE_TEST_HOME ?? os.homedir()
  },
  data,
  bin: path.join(cache, "bin"),
  log: path.join(data, "log"),
  repos: path.join(data, "repos"),
  cache,
  config,
  state,
  tmp,
  banyan: {
    data: banyanData,
    cache: banyanCache,
    config: banyanConfig,
    state: banyanState,
    tmp: banyanTmp,
    bin: path.join(banyanCache, "bin"),
    log: path.join(banyanData, "log"),
    repos: path.join(banyanData, "repos"),
  },
}

export const Path = paths

Flock.setGlobal({ state })

await Promise.all([
  fs.mkdir(Path.data, { recursive: true }),
  fs.mkdir(Path.config, { recursive: true }),
  fs.mkdir(Path.state, { recursive: true }),
  fs.mkdir(Path.tmp, { recursive: true }),
  fs.mkdir(Path.log, { recursive: true }),
  fs.mkdir(Path.bin, { recursive: true }),
  fs.mkdir(Path.repos, { recursive: true }),
  fs.mkdir(Path.banyan.data, { recursive: true }),
  fs.mkdir(Path.banyan.config, { recursive: true }),
  fs.mkdir(Path.banyan.state, { recursive: true }),
  fs.mkdir(Path.banyan.tmp, { recursive: true }),
  fs.mkdir(Path.banyan.log, { recursive: true }),
  fs.mkdir(Path.banyan.bin, { recursive: true }),
  fs.mkdir(Path.banyan.repos, { recursive: true }),
])

export class Service extends Context.Service<Service, Interface>()("@opencode/Global") {}

export interface Interface {
  readonly home: string
  readonly data: string
  readonly cache: string
  readonly config: string
  readonly state: string
  readonly tmp: string
  readonly bin: string
  readonly log: string
  readonly repos: string
  readonly banyan: {
    readonly data: string
    readonly cache: string
    readonly config: string
    readonly state: string
    readonly tmp: string
    readonly bin: string
    readonly log: string
    readonly repos: string
  }
}

export function make(input: Partial<Interface> = {}): Interface {
  return {
    home: Path.home,
    data: Path.data,
    cache: Path.cache,
    config: Flag.OPENCODE_CONFIG_DIR ?? Path.config,
    state: Path.state,
    tmp: Path.tmp,
    bin: Path.bin,
    log: Path.log,
    repos: Path.repos,
    banyan: {
      data: Path.banyan.data,
      cache: Path.banyan.cache,
      config: Flag.BANYANCODE_CONFIG_DIR ?? Path.banyan.config,
      state: Path.banyan.state,
      tmp: Path.banyan.tmp,
      bin: Path.banyan.bin,
      log: Path.banyan.log,
      repos: Path.banyan.repos,
    },
    ...input,
  }
}

export const layer = Layer.effect(
  Service,
  Effect.sync(() => Service.of(make())),
)

export const defaultLayer = layer
export const node = LayerNode.make(layer, [])

export const layerWith = (input: Partial<Interface>) =>
  Layer.effect(
    Service,
    Effect.sync(() => Service.of(make(input))),
  )

export * as Global from "./global"
