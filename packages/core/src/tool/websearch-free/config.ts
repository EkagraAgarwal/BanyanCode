export interface Config {
  readonly disabled: boolean
}

export const config = (): Config => ({
  disabled: process.env.BANYANCODE_DISABLE_WEBSEARCH === "1",
})