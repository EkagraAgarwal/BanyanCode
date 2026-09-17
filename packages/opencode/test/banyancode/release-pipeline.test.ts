import { describe, expect, test } from "bun:test"
import path from "node:path"

const repoRoot = path.resolve(import.meta.dirname, "../../../..")

const readRepo = async (rel: string) => {
  const text = await Bun.file(path.join(repoRoot, rel)).text()
  expect(text.length).toBeGreaterThan(0)
  return text
}

// Static validation for the low-risk release-pipeline optimization
// (audit:publish-speed / research:fast-publish). Parses workflow YAML and
// scripts as text — no workflow runs, no publish, no network.
describe("release pipeline (fast-publish, low-risk)", () => {
  test("publish.yml uses fast-compression short-retention artifact uploads", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const compression = yml.match(/compression-level:\s*1/g) ?? []
    // Unix + raw Windows + signed final uploads.
    expect(compression.length).toBeGreaterThanOrEqual(3)
    const retention = yml.match(/retention-days:\s*1/g) ?? []
    expect(retention.length).toBeGreaterThanOrEqual(3)
  })

  test("raw Windows artifacts use unsigned- prefix; central pattern is Unix-only", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    expect(yml).toContain("name: unsigned-banyancode-${{ matrix.target }}")
    expect(yml).toContain("name: unsigned-banyancode-windows-x64")
    expect(yml).toContain("name: final-banyancode-windows-x64")
    expect(yml).not.toContain("banyancode-windows-x64-signed")
    // Central download stays on the banyancode-* pattern (Unix only now),
    // with a stub download preserving the 11th npm platform package
    // (triage baseline, never a GH asset) and a dynamic download for the
    // final Windows artifact (signed final or raw unsigned, no duplicate).
    expect(yml).toContain("pattern: banyancode-*")
    expect(yml).toContain("pattern: unsigned-banyancode-windows-x64-baseline")
    expect(yml).toContain("name: ${{ needs.sign-windows.outputs.artifact-name }}")
  })

  test("sign-windows fast path: outputs artifact-name, no duplicate fallback", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    expect(yml).toContain("artifact-name: ${{ steps.artifact.outputs.name }}")
    expect(yml).toContain("Resolve final Windows artifact name")
    expect(yml).toContain("name=final-banyancode-windows-x64")
    expect(yml).toContain("name=unsigned-banyancode-windows-x64")
    // Missing-secret path must not repack or re-upload a duplicate.
    expect(yml).not.toContain("unsigned fallback")
    // A failed signing attempt fails the job instead of silently falling
    // back: no masking in the sign-windows section.
    const signSection = yml.slice(yml.indexOf("sign-windows:"), yml.indexOf("publish:"))
    expect(signSection).not.toMatch(/\|\| true\s*$/m)
  })

  test("publish.yml preserves 10 GH assets and generates release notes", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    for (const asset of [
      "banyancode-linux-x64.tar.gz",
      "banyancode-linux-arm64.tar.gz",
      "banyancode-darwin-arm64.zip",
      "banyancode-windows-x64.zip",
    ]) {
      expect(yml).toContain(asset)
    }
    const allowlist = yml.slice(yml.indexOf("files=("), yml.indexOf(")", yml.indexOf("files=(")))
    expect(allowlist).not.toContain("dist/banyancode-windows-x64-baseline")
    expect(yml).toContain("--generate-notes")
  })

  test("finalize runs only after successful npm publish (no always/|| true masking)", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    // No YAML `if: always()` step key (the phrase still appears inside
    // explanatory comments, so match the key form, not the substring).
    expect(yml).not.toMatch(/^\s+if:\s*always\(\)/m)
    const finalize = yml.slice(yml.indexOf("Publish release (finalize draft)"))
    // No shell `|| true` masking at end of a command line (the phrase still
    // appears inside an explanatory comment, so match EOL form).
    expect(finalize).not.toMatch(/\|\| true\s*$/m)
    expect(finalize).toContain("--draft=false")
  })

  test("publish job skips cross-platform install flags", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const publishSection = yml.slice(yml.indexOf("Publish BanyanCode to npm"))
    expect(publishSection).not.toContain('--os="*"')
    expect(yml).toContain("install-flags: ''")
  })

  test("build.ts uses fastest gzip for Linux release tars only", async () => {
    const build = await readRepo("packages/opencode/script/build.ts")
    expect(build).toContain("gzip -1")
    expect(build).not.toContain("tar -czf")
    // npm platform tgzs via `bun pm pack` are untouched.
    const publish = await readRepo("packages/opencode/script/publish.ts")
    expect(publish).toContain("bun pm pack")
  })

  test("publish.ts asserts uniform dist versions before publishing", async () => {
    const publish = await readRepo("packages/opencode/script/publish.ts")
    expect(publish).toContain("versions mismatch")
  })

  test("tag-release.yml is the sole normal tag creator and dispatches publish", async () => {
    const tag = await readRepo(".github/workflows/tag-release.yml")
    expect(tag).toContain("actions: write")
    expect(tag).toContain("gh workflow run publish.yml")
    expect(tag).toContain('-f version="${CURRENT}"')
  })

  test("Azure secrets are mapped into Decide + login steps", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const decideBlock = yml.slice(yml.indexOf("Decide signing path"), yml.indexOf("Azure login"))
    for (const name of [
      "AZURE_CLIENT_ID",
      "AZURE_TENANT_ID",
      "AZURE_SUBSCRIPTION_ID",
      "AZURE_TRUSTED_SIGNING_ACCOUNT_NAME",
      "AZURE_TRUSTED_SIGNING_CERTIFICATE_PROFILE",
      "AZURE_TRUSTED_SIGNING_ENDPOINT",
    ]) {
      // preflight.yml idiom: secret -> step env, so $env: detection works.
      expect(decideBlock).toContain(`${name}: \${{ secrets.${name} }}`)
    }
    expect(decideBlock).toContain("$env:AZURE_CLIENT_ID")
    const loginBlock = yml.slice(yml.indexOf("Azure login"), yml.indexOf("Sign BanyanCode Windows binaries"))
    for (const name of ["AZURE_CLIENT_ID", "AZURE_TENANT_ID", "AZURE_SUBSCRIPTION_ID"]) {
      expect(loginBlock).toContain(`${name}: \${{ secrets.${name} }}`)
    }
    expect(loginBlock).toContain("client-id: ${{ env.AZURE_CLIENT_ID }}")
  })

  test("unsigned ZIP is packaged centrally before upload, gated on signed output", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const packageIdx = yml.indexOf("Package unsigned Windows archive")
    const uploadIdx = yml.indexOf("Upload all release artifacts")
    const allowlistIdx = yml.indexOf("files=(")
    expect(packageIdx).toBeGreaterThan(-1)
    // Ordering is the guarantee: raw dir -> central zip -> allowlist upload.
    expect(packageIdx).toBeLessThan(uploadIdx)
    expect(uploadIdx).toBeLessThan(allowlistIdx)
    const packageBlock = yml.slice(packageIdx, uploadIdx)
    expect(packageBlock).toContain("needs.sign-windows.outputs.signed != 'true'")
    expect(packageBlock).toContain("working-directory: packages/opencode/dist")
    expect(packageBlock).toContain("zip -1")
    expect(packageBlock).toContain("banyancode-windows-x64.zip")
    expect(packageBlock).toContain("test -f")
  })

  test("missing shipping assets fail loudly, never warn-and-continue", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const uploadBlock = yml.slice(yml.indexOf("Upload all release artifacts"), yml.indexOf("Publish BanyanCode to npm"))
    expect(uploadBlock).toContain("::error::missing")
    expect(uploadBlock).toContain("exit 1")
    expect(uploadBlock).not.toContain("::warning::missing")
  })

  test("publish job keeps the repository guard with success-only needs", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    expect(yml).toContain(
      "if: github.repository == 'EkagraAgarwal/BanyanCode' && needs.version.outputs.version != ''",
    )
  })

  test("sign-windows exposes signed + artifact-name outputs for both paths", async () => {
    const yml = await readRepo(".github/workflows/publish.yml")
    const signHeader = yml.slice(yml.indexOf("sign-windows:"), yml.indexOf("Download Windows CLI artifact"))
    expect(signHeader).toContain("artifact-name: ${{ steps.artifact.outputs.name }}")
    expect(signHeader).toContain("signed: ${{ steps.signing.outputs.enabled }}")
    // Resolve branches on the detection output: signed run -> final
    // artifact, secrets absent -> raw unsigned artifact, no third path.
    const resolveBlock = yml.slice(yml.indexOf("Resolve final Windows artifact name"))
    expect(resolveBlock).toContain('"${{ steps.signing.outputs.enabled }}" -eq "true"')
    const finalIdx = resolveBlock.indexOf("name=final-banyancode-windows-x64")
    const unsignedIdx = resolveBlock.indexOf("name=unsigned-banyancode-windows-x64")
    expect(finalIdx).toBeGreaterThan(-1)
    expect(unsignedIdx).toBeGreaterThan(finalIdx)
  })
})
