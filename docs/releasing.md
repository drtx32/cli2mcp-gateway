# Releasing

## First npm publication

The package is not on npm yet. Bootstrap the package once from a clean checkout after the CI workflow has been merged:

```bash
git checkout main
git pull --ff-only origin main
npm ci
npm test
npm publish --access public
```

Authenticate with the npm account that should own the unscoped package name before publishing (for example, with `npm login`). Do not add an npm password or publish token to GitHub.

After the first successful publication, open the package's **Settings → Trusted Publisher** page on npmjs.com and add:

- Provider: GitHub Actions
- User or organization: `drtx32`
- Repository: `cli2mcp-gateway`
- Workflow filename: `publish.yml`
- Environment: leave blank
- Allowed action: direct `npm publish`

Use the exact workflow filename. Complete the first OIDC publication within two days of creating the trusted publisher; npm expires an unvalidated configuration after that period.

## Subsequent releases

1. Update `version` in `package.json` and the matching `package-lock.json`, then merge the change to `main`.
2. Create and push a matching version tag from that main commit. For example, for version `1.0.2`:

   ```bash
   git switch main
   git pull --ff-only origin main
   git tag v1.0.2
   git push origin v1.0.2
   ```

3. GitHub Actions runs `npm ci` and `npm test`, verifies the tag version matches `package.json`, verifies the tagged commit is on `main`, then publishes with npm trusted publishing (OIDC).

A GitHub Release object and the Deployments page are not required. Check the run under the repository's **Actions** tab. Releases are published only for tags matching `v*`; failed checks prevent publication.

The first version must be published manually because npm trusted publishers are configured in the settings of an existing package. From the next version onward, tags trigger the automated publication workflow.
