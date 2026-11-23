import { Firestore } from '@google-cloud/firestore';
import { ExternalAccountClient, GoogleAuth } from 'google-auth-library';
import { getVercelOidcToken } from '@vercel/oidc';

export const FIREBASE_PROJECT_ID = 'leadder-d2ca1';
let database;

export function firebaseConnectionOptions(env = process.env) {
  const projectId = env.FIREBASE_PROJECT_ID || FIREBASE_PROJECT_ID;
  if (projectId !== FIREBASE_PROJECT_ID) throw new Error('Firebase connection must belong to leadder-d2ca1');
  const options = { projectId, databaseId: '(default)', preferRest: true };
  if (env.FIRESTORE_EMULATOR_HOST) return options;
  const { GCP_PROJECT_NUMBER, GCP_SERVICE_ACCOUNT_EMAIL, GCP_WORKLOAD_IDENTITY_POOL_ID, GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID } = env;
  if (!/^\d+$/.test(GCP_PROJECT_NUMBER || '') || !GCP_SERVICE_ACCOUNT_EMAIL?.endsWith('@leadder-d2ca1.iam.gserviceaccount.com') ||
      !/^[a-z0-9-]+$/.test(GCP_WORKLOAD_IDENTITY_POOL_ID || '') || !/^[a-z0-9-]+$/.test(GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID || '')) {
    throw new Error('Firebase workload identity connection is not configured');
  }
  const authClient = ExternalAccountClient.fromJSON({
    type: 'external_account',
    audience: `//iam.googleapis.com/projects/${GCP_PROJECT_NUMBER}/locations/global/workloadIdentityPools/${GCP_WORKLOAD_IDENTITY_POOL_ID}/providers/${GCP_WORKLOAD_IDENTITY_POOL_PROVIDER_ID}`,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: 'https://sts.googleapis.com/v1/token',
    service_account_impersonation_url: `https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts/${GCP_SERVICE_ACCOUNT_EMAIL}:generateAccessToken`,
    subject_token_supplier: { getSubjectToken: () => getVercelOidcToken() }
  });
  if (!authClient) throw new Error('Firebase identity initialization failed');
  authClient.scopes = ['https://www.googleapis.com/auth/datastore'];
  options.auth = new GoogleAuth({ authClient, projectId });
  return options;
}

export function getLeaderboardDatabase() {
  if (database) return database;
  database = new Firestore(firebaseConnectionOptions());
  return database;
}
