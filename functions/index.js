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
export { memberCreate, memberSetRoles, memberDeactivate } from './src/members.js';
export {
  handbookAttestLicense,
  handbookSetEntry,
  handbookRemoveEdition,
  handbookGetCrosswalk,
  handbookIngestFromUpload,
  handbookConfirmDrafts,
  handbookSeedTreeFromDrafts,
} from './src/handbook.js';
export {
  llmDraftShortRefs,
  llmConfirmShortRefs,
  llmAsk,
} from './src/llm-assist.js';
export {
  assessmentCreate,
  assessmentRateItem,
  assessmentOverrideStandard,
  assessmentSetApplicability,
  assessmentComplete,
} from './src/assessment.js';
export {
  libraryCreateFolder,
  libraryRenameFolder,
  libraryRegisterFile,
  libraryMoveFile,
  libraryArchiveFile,
  librarySearch,
} from './src/library.js';
export {
  credentialUpsertItem,
  credentialVerify,
  credentialSweep,
  hrDocRegister,
  hrDocArchive,
  employeeFileGet,
} from './src/personnel-file.js';
export { logsHubRoster, logsHubHistory } from './src/logs-hub.js';
export { logTemplateCreate, logTemplateUpdate, logTemplateRetire } from './src/log-templates.js';
export {
  qiCreateStudy, qiAddDataPoint, qiSetBaseline, qiAddAction,
  qiUpdateAction, qiAddAnalysis, qiAdvanceStatus, qiCloseStudy,
} from './src/qi.js';
export {
  committeeCreate, committeeUpdate, meetingTemplateSave, meetingTemplateRetire,
  meetingCreate, meetingSaveSection, meetingSetAttendance, meetingFinalizeMinutes,
} from './src/committees.js';
export {
  incidentReport, incidentSetInvestigation, incidentAddAction, incidentUpdateAction,
  incidentAdvanceStatus, incidentClose, incidentFeedToQI,
} from './src/incidents.js';
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
