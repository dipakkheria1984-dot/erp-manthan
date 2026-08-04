-- Staff can email a report or a student ledger on request; those sends are
-- logged like any other notification and need a kind of their own.
ALTER TYPE "NotificationKind" ADD VALUE 'DOCUMENT';
