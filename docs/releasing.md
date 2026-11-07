# Releasing

A release is a GitHub Release with the macOS app (signed with Developer ID, notarized) and the npm
package. The installer fetches the app from the latest **published** release
(`releases/latest/download/agentlink-macos-arm64.zip`), so publishing a release changes what new
Macs install.

## One-time setup

You need an Apple Developer Program membership, as the Account Holder or an Admin.

### 1. Developer ID Application certificate

1. In **Keychain Access → Certificate Assistant → Request a Certificate From a Certificate
   Authority…**, enter your email and choose **Saved to disk**.
2. At [developer.apple.com → Certificates](https://developer.apple.com/account/resources/certificates/list),
   click **+**, choose **Developer ID Application** (profile type G2 Sub-CA), upload the request,
   and download the certificate. Double-click it to add it to your keychain.
3. Check: `security find-identity -v -p codesigning` lists
   `Developer ID Application: <name> (CZ63J37ULN)`. The team ID must be **CZ63J37ULN**, the team
   the installer requires (`TEAM` in `install.sh`).

### 2. Notarization key

At [App Store Connect → Users and Access → Integrations → Team Keys](https://appstoreconnect.apple.com/access/integrations/api),
create a key with the **Developer** role. Download the `.p8` file (you can only download it once),
and note its **Key ID** and the **Issuer ID** shown above the list.

For notarizing on your own Mac:

    xcrun notarytool store-credentials agentlink-notary --key AuthKey_XXXX.p8 --key-id <key id> --issuer <issuer id>
    npm run build:app -- --notarize agentlink-notary

### 3. GitHub secrets

Export the certificate with its private key: in Keychain Access, under **My Certificates**,
right-click **Developer ID Application: …**, choose **Export…**, save it as a `.p12` and set a
password. Then:

    base64 -i cert.p12 | gh secret set MACOS_CERT_P12
    gh secret set MACOS_CERT_PASSWORD            # the .p12 password
    base64 -i AuthKey_XXXX.p8 | gh secret set NOTARY_KEY_P8
    gh secret set NOTARY_KEY_ID
    gh secret set NOTARY_ISSUER_ID

Delete the exported `.p12` afterwards. To check the secrets, run **Actions → Release → Run
workflow**: it builds, signs, notarizes and tests the app without making a release, and keeps the
files as a workflow artifact.

### 4. npm trusted publishing

On [npmjs.com](https://www.npmjs.com/package/@tombaldwin/agentlink/access), open the package's
**Settings → Trusted publishing**, choose **GitHub Actions**, and enter owner `tombaldwin`,
repository `agentlink` and workflow `release.yml` (no environment). The workflow then publishes to
npm without a token, with provenance. A package must exist on npm before it can be set up, so the
first version (0.1.0) was published by hand.

## Each release

1. Set the version in `package.json` and `src/config.js` (`VERSION`), and date its section in
   `CHANGELOG.md` (`## X.Y.Z — YYYY-MM-DD`).
2. Commit, then tag and push: `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. The **Release** workflow builds, signs, notarizes and staples the app, runs the end-to-end tests
   against it, and creates a **draft** release with the CHANGELOG section as its notes.
4. Check the draft, then publish it (`gh release edit vX.Y.Z --draft=false --latest`). New installs
   on Apple silicon Macs get this app from then on.
5. Publishing the release runs the workflow again, which publishes the package attached to the
   release to npm. Check it with `npm view @tombaldwin/agentlink version`. Publish the release
   with your own account (the web page or `gh`): GitHub doesn't start workflows for a release
   published by a workflow's own token.

The bundle ID (`io.github.tombaldwin.agentlink`, in `scripts/build-app.mjs`) must never change:
macOS ties each user's Local Network permission to it.
