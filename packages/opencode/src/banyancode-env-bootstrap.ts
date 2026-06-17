/** BanyanCode builds default-enable; set `BANYANCODE_ENABLE=0` before launch to opt out. */
if (process.env.BANYANCODE_ENABLE === undefined || process.env.BANYANCODE_ENABLE === "") {
  process.env.BANYANCODE_ENABLE = "1"
}
