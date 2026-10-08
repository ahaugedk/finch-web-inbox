import { sqliteTable, text, integer, index, uniqueIndex, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';

export const users = sqliteTable('users', {
  id: text('id').primaryKey(),
  email: text('email').notNull().unique(),
  createdAt: integer('created_at').notNull(),
  lastOrgId: text('last_org_id'),
});
export const sessions = sqliteTable('sessions', {
  tokenHash: text('token_hash').primaryKey(),
  userId: text('user_id').notNull().references(() => users.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_sessions_user').on(t.userId)]);
export const notificationPreferences = sqliteTable('notification_preferences', {
  userId: text('user_id').notNull().references(() => users.id),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  enabled: integer('enabled').notNull().default(0),
  waitingJson: text('waiting_json').notNull().default('{}'),
  revision: integer('revision').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
}, t => [primaryKey({columns:[t.userId,t.organizationId]})]);
export const agentConnections = sqliteTable('agent_connections', {
  id:text('id').primaryKey(),
  agentName:text('agent_name'),
  connectedAt:integer('connected_at'),
  createdAt:integer('created_at').notNull(),
  expiresAt:integer('expires_at').notNull(),
},t=>[index('idx_agent_connections_expiry').on(t.expiresAt)]);
export const loginChallenges = sqliteTable('login_challenges', {
  id: text('id').primaryKey(),
  email: text('email').notNull(),
  codeHash: text('code_hash').notNull(),
  expiresAt: integer('expires_at').notNull(),
  attempts: integer('attempts').notNull().default(0),
  consumed: integer('consumed').notNull().default(0),
  createdAt: integer('created_at').notNull(),
}, (t) => [index('idx_challenges_email_created').on(t.email, t.createdAt)]);
export const rateLimits = sqliteTable('rate_limits', {
  key: text('key').primaryKey(),
  count: integer('count').notNull(),
  expiresAt: integer('expires_at').notNull(),
});
export const organizations = sqliteTable('organizations', {
  id: text('id').primaryKey(),
  ownerId: text('owner_id').notNull().references(() => users.id),
  name: text('name').notNull(),
  stateJson: text('state_json').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [index('idx_organizations_owner_updated').on(t.ownerId, t.updatedAt)]);

export const organizationRoles = sqliteTable('organization_roles', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  title: text('title').notNull(),
  description: text('description').notNull(),
  revision: integer('revision').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (t) => [index('idx_org_roles_live').on(t.organizationId, t.deletedAt)]);
export const organizationOnboarding = sqliteTable('organization_onboarding', {
  organizationId: text('organization_id').primaryKey().references(()=>organizations.id),
  profileJson: text('profile_json').notNull(),
  phase: text('phase').notNull().default('offered'),
  caseId: text('case_id'),
  tutorialStep: integer('tutorial_step').notNull().default(0),
  tutorialDone: integer('tutorial_done').notNull().default(0),
  revision: integer('revision').notNull().default(0),
  updatedAt: integer('updated_at').notNull(),
});
export const pageUserStates = sqliteTable('page_user_states', {
  organizationId:text('organization_id').notNull().references(()=>organizations.id),
  pageId:text('page_id').notNull(),
  userId:text('user_id').notNull().references(()=>users.id),
  valuesJson:text('values_json').notNull(),
  revision:integer('revision').notNull().default(1),
  updatedAt:integer('updated_at').notNull(),
},t=>[primaryKey({columns:[t.organizationId,t.pageId,t.userId]})]);
export const pageAgentRequests = sqliteTable('page_agent_requests', {
  organizationId:text('organization_id').notNull().references(()=>organizations.id),
  pageId:text('page_id').notNull(),
  userId:text('user_id').notNull().references(()=>users.id),
  requestId:text('request_id').notNull(),
  caseId:text('case_id').notNull(),
  createdAt:integer('created_at').notNull(),
},t=>[primaryKey({columns:[t.organizationId,t.pageId,t.userId,t.requestId]})]);
export const dataWorkRequests = sqliteTable('data_work_requests', {
  organizationId:text('organization_id').notNull().references(()=>organizations.id),
  userId:text('user_id').notNull().references(()=>users.id),
  requestId:text('request_id').notNull(),
  kind:text('kind').notNull(),
  caseId:text('case_id').notNull(),
  fileId:text('file_id').references(()=>storedFiles.id),
  createdAt:integer('created_at').notNull(),
},t=>[primaryKey({columns:[t.organizationId,t.userId,t.requestId]}),index('idx_data_work_file').on(t.organizationId,t.fileId)]);
export const organizationMembers = sqliteTable('organization_members', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  email: text('email').notNull(),
  userId: text('user_id').references(() => users.id),
  displayName: text('display_name').notNull().default(''),
  roleId: text('role_id').references(() => organizationRoles.id),
  includeInGraph: integer('include_in_graph').notNull().default(0),
  status: text('status').notNull(),
  expiresAt: integer('expires_at'),
  invitedBy: text('invited_by').notNull().references(() => users.id),
  revision: integer('revision').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
}, (t) => [uniqueIndex('idx_org_members_email').on(t.organizationId, t.email), index('idx_org_members_user_status').on(t.userId, t.status), index('idx_org_members_invites').on(t.email, t.status, t.expiresAt)]);

export const taskAssignments = sqliteTable('task_assignments', {
  organizationId: text('organization_id').notNull().references(()=>organizations.id),
  taskId: text('task_id').notNull(),
  assigneeId: text('assignee_id').notNull().references(()=>users.id),
  reason: text('reason').notNull(),
  basisJson: text('basis_json').notNull().default('[]'),
  revision: integer('revision').notNull().default(0),
  updatedBy: text('updated_by').notNull().references(()=>users.id),
  updatedAt: integer('updated_at').notNull(),
}, t=>[primaryKey({columns:[t.organizationId,t.taskId]}),index('idx_task_assignments_member').on(t.organizationId,t.assigneeId)]);

// User-defined tables have a validated schema and store records independently of semantic knowledge.
export const dataTables = sqliteTable('data_tables', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  physicalName: text('physical_name').notNull().unique(),
  description: text('description').notNull().default(''),
  columnsJson: text('columns_json').notNull(),
  sourceUrl: text('source_url').notNull().default(''),
  revision: integer('revision').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (t) => [index('idx_data_tables_organization').on(t.organizationId), uniqueIndex('idx_data_tables_org_name_live').on(t.organizationId, t.name).where(sql`${t.deletedAt} IS NULL`)]);
export const storedFiles = sqliteTable('stored_files', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(() => organizations.id),
  name: text('name').notNull(),
  description: text('description').notNull().default(''),
  contentType: text('content_type').notNull(),
  sizeBytes: integer('size_bytes').notNull(),
  sha256: text('sha256').notNull(),
  objectKey: text('object_key').notNull(),
  sourceUrl: text('source_url').notNull().default(''),
  revision: integer('revision').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
  deletedAt: integer('deleted_at'),
}, (t) => [index('idx_stored_files_organization_live').on(t.organizationId, t.deletedAt)]);

export const inboundSettings = sqliteTable('organization_inbound_settings', {
  organizationId: text('organization_id').primaryKey().references(()=>organizations.id),
  alias: text('alias').notNull().unique(),
  enabled: integer('enabled').notNull().default(0),
  allowedSendersJson: text('allowed_senders_json').notNull().default('[]'),
  blockedMembersJson: text('blocked_members_json').notNull().default('[]'),
  revision: integer('revision').notNull().default(0),
  writeId: text('write_id').notNull(),
  updatedAt: integer('updated_at').notNull(),
});

export const organizationInvitationTokens = sqliteTable('organization_invitation_tokens', {
  tokenHash: text('token_hash').primaryKey(),
  memberId: text('member_id').notNull().references(()=>organizationMembers.id),
  expiresAt: integer('expires_at').notNull(),
  createdAt: integer('created_at').notNull(),
  decision: text('decision'),
  decidedAt: integer('decided_at'),
  decisionId: text('decision_id'),
}, table => [uniqueIndex('idx_invitation_token_member').on(table.memberId), index('idx_invitation_token_expiry').on(table.expiresAt)]);
export const inboundMessages = sqliteTable('inbound_messages', {
  id: text('id').primaryKey(),
  organizationId: text('organization_id').notNull().references(()=>organizations.id),
  providerEmailId: text('provider_email_id').notNull(),
  webhookId: text('webhook_id').notNull(),
  sender: text('sender').notNull(),
  subject: text('subject').notNull().default(''),
  status: text('status').notNull(),
  reason: text('reason').notNull().default(''),
  taskId: text('task_id'),
  contentJson: text('content_json'),
  leaseId: text('lease_id').notNull(),
  leaseUntil: integer('lease_until').notNull(),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
},t=>[uniqueIndex('idx_inbound_org_email').on(t.organizationId,t.providerEmailId),index('idx_inbound_org_recent').on(t.organizationId,t.createdAt)]);
export const inboundRejectionNotices = sqliteTable('inbound_rejection_notices', {
  id: text('id').primaryKey(),
  inboundMessageId: text('inbound_message_id').notNull().references(()=>inboundMessages.id),
  status: text('status').notNull().default('pending'),
  reason: text('reason').notNull().default(''),
  payloadJson: text('payload_json'),
  firstAttemptAt: integer('first_attempt_at'),
  providerMessageId: text('provider_message_id'),
  sentAt: integer('sent_at'),
  leaseId: text('lease_id'),
  leaseUntil: integer('lease_until').notNull().default(0),
  createdAt: integer('created_at').notNull(),
  updatedAt: integer('updated_at').notNull(),
},t=>[uniqueIndex('idx_inbound_notice_message').on(t.inboundMessageId)]);
export const workIntakeRequests = sqliteTable('work_intake_requests', {
  organizationId: text('organization_id').notNull().references(()=>organizations.id),
  userId: text('user_id').notNull().references(()=>users.id),
  requestId: text('request_id').notNull(),
  taskId: text('task_id').notNull(),
  kind: text('kind').notNull(),
  createdAt: integer('created_at').notNull(),
},t=>[uniqueIndex('idx_work_intake_request').on(t.organizationId,t.userId,t.requestId)]);
