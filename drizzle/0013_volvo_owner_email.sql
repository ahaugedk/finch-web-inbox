-- Requested live-data correction: Volvo Trucks belongs to Rune's orderly.ai account.
-- Match the verified tenant and both accounts; unrelated tenants and users stay intact.
-- A fresh installation without this tenant is a no-op. Sites applies migrations atomically.
UPDATE organizations
SET owner_id = '4b231426-39b8-4112-93d4-b587a082a5e7',
    revision = revision + 1,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE id = '37c57cc9-eaaf-41b3-8bcd-1567ffebf16c'
  AND owner_id = 'da336f19-9402-4e94-ae1e-1129495d01db'
  AND EXISTS (SELECT 1 FROM users WHERE id = owner_id AND email = 'rune@orderly.dk')
  AND EXISTS (SELECT 1 FROM users WHERE id = '4b231426-39b8-4112-93d4-b587a082a5e7' AND email = 'rune@orderly.ai')
  AND EXISTS (SELECT 1 FROM organization_members
    WHERE organization_id = organizations.id AND email = 'rune@orderly.ai'
      AND user_id = '4b231426-39b8-4112-93d4-b587a082a5e7' AND status = 'active');
--> statement-breakpoint
UPDATE task_assignments
SET assignee_id = '4b231426-39b8-4112-93d4-b587a082a5e7',
    reason = 'Overført til rune@orderly.ai efter brugerens anmodning om ejerskifte. Tidligere tildelingsgrundlag: ' || reason,
    revision = revision + 1,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE organization_id = '37c57cc9-eaaf-41b3-8bcd-1567ffebf16c'
  AND assignee_id = 'da336f19-9402-4e94-ae1e-1129495d01db'
  AND EXISTS (SELECT 1 FROM organizations WHERE id = task_assignments.organization_id
    AND owner_id = '4b231426-39b8-4112-93d4-b587a082a5e7');
--> statement-breakpoint
-- Use the same revocation semantics as the member-delete API; preserve historical references.
UPDATE organization_members
SET status = 'revoked', include_in_graph = 0, revision = revision + 1,
    updated_at = CAST(strftime('%s', 'now') AS INTEGER) * 1000
WHERE organization_id = '37c57cc9-eaaf-41b3-8bcd-1567ffebf16c'
  AND email = 'rune@orderly.dk' AND user_id = 'da336f19-9402-4e94-ae1e-1129495d01db'
  AND status != 'revoked'
  AND EXISTS (SELECT 1 FROM organizations WHERE id = organization_members.organization_id
    AND owner_id = '4b231426-39b8-4112-93d4-b587a082a5e7');
--> statement-breakpoint
UPDATE users SET last_org_id = NULL
WHERE id = 'da336f19-9402-4e94-ae1e-1129495d01db' AND email = 'rune@orderly.dk'
  AND last_org_id = '37c57cc9-eaaf-41b3-8bcd-1567ffebf16c'
  AND EXISTS (SELECT 1 FROM organizations WHERE id = users.last_org_id
    AND owner_id = '4b231426-39b8-4112-93d4-b587a082a5e7');
