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
export { onNotificationCreated, morningDigest } from './src/notifier.js';

// Pending per BUILD-MANIFEST.md:
//   lms.js       — course.publish, quiz.submit, lesson views, completion tx,
//                  certificates, /verify public endpoint
//   catalog.js   — importPackage, exportPackage, catalogSync
