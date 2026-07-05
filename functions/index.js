// functions/index.js — deployment surface. util.js initializes the Admin app.
export {
  scanResolve,
  taskCompleteFromScan,
  logAdhoc,
  evidenceFinalize,
  evidenceSupersede,
  documentApproveVersion,
  checkpointMint,
  checkpointRotateToken,
  surveyorGrant,
  surveyorRevoke,
} from './src/callables.js';

export { registerCheckSubmit, expirationSweep } from './src/registers.js';
export {
  onPersonnelCreated,
  onPersonnelUpdated,
  trainingSweep,
  trainingAttest,
  trainingApproveExternal,
  trainingMatrix,
} from './src/training.js';
export { materializeTasks } from './src/scheduler.js';
export {
  coursePublish,
  enrollmentLessonView,
  lessonMarkComplete,
  quizSubmit,
  verifyCertificate,
} from './src/lms.js';
export {
  catalogImportPackage,
  catalogExportPackage,
  catalogSync,
} from './src/catalog.js';
export { onNotificationCreated, morningDigest } from './src/notifier.js';

// Pending per BUILD-MANIFEST.md:
//   (backend complete — remaining work is the React+Vite PWA, Sessions E/F)
