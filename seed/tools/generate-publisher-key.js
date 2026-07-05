#!/usr/bin/env node
// seed/tools/generate-publisher-key.js
// Generates an Ed25519 publisher keypair, writes the PUBLIC half into
// functions/src/publisherKey.js (committed, shipped to all deployments),
// and pushes the PRIVATE half into Google Secret Manager (never on disk,
// never in git). Run once on DUDESTER, in your CONTENT org's GCP project.
//
// Prereqs:
//   npm i @google-cloud/secret-manager
//   gcloud auth application-default login   (or GOOGLE_APPLICATION_CREDENTIALS)
//   Secret Manager API enabled on the project.
//
// Usage:
//   node seed/tools/generate-publisher-key.js <gcp-project-id>
//
// After running:
//   - commit the updated functions/src/publisherKey.js
//   - grant catalog.exportPackage's runtime SA access to the secret:
//       gcloud secrets add-iam-policy-binding PUBLISHER_PRIVATE_KEY \
//         --member="serviceAccount:<functions-SA>" \
//         --role="roles/secretmanager.secretAccessor" --project <project>

import { generateKeyPairSync } from 'node:crypto';
import { writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const projectId = process.argv[2];
if (!projectId) {
  console.error('Usage: node seed/tools/generate-publisher-key.js <gcp-project-id>');
  process.exit(1);
}

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, '../..');
const SECRET_ID = 'PUBLISHER_PRIVATE_KEY';

const { publicKey, privateKey } = generateKeyPairSync('ed25519');
const publicPem = publicKey.export({ type: 'spki', format: 'pem' });
const privatePem = privateKey.export({ type: 'pkcs8', format: 'pem' });

// 1) write the public key module (safe to commit) ----------------------
const keyModule = `// Publisher PUBLIC key — verifies stock content package signatures.
// PRODUCTION KEY. Private half lives ONLY in Secret Manager (${SECRET_ID})
// on project "${projectId}". Rotating this requires redeploying every
// licensee deployment. Generated ${new Date().toISOString()}.
export const PUBLISHER_PUBLIC_KEY_PEM = \`${publicPem}\`;
`;
writeFileSync(resolve(repoRoot, 'functions/src/publisherKey.js'), keyModule);
console.log('✓ wrote functions/src/publisherKey.js (public key — commit this)');

// 2) push private key to Secret Manager --------------------------------
const { SecretManagerServiceClient } = await import('@google-cloud/secret-manager');
const client = new SecretManagerServiceClient();
const parent = `projects/${projectId}`;

try {
  await client.createSecret({
    parent,
    secretId: SECRET_ID,
    secret: { replication: { automatic: {} } },
  });
  console.log(`✓ created secret ${SECRET_ID}`);
} catch (e) {
  if (e.code === 6 /* ALREADY_EXISTS */) {
    console.log(`• secret ${SECRET_ID} exists — adding a new version (rotation)`);
  } else {
    throw e;
  }
}

const [version] = await client.addSecretVersion({
  parent: `${parent}/secrets/${SECRET_ID}`,
  payload: { data: Buffer.from(privatePem, 'utf8') },
});
console.log(`✓ added secret version: ${version.name}`);

// private key never touches disk or stdout
console.log('\nDone. The private key is in Secret Manager only — it was never written to disk.');
console.log('\nNext:');
console.log('  1. git add functions/src/publisherKey.js && git commit -m "Production publisher key"');
console.log(`  2. Grant your functions runtime SA secretAccessor on ${SECRET_ID}`);
console.log('  3. Wire catalog.exportPackage to read the secret (already uses defineSecret).');
