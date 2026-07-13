-- ===========================================================================
-- CompanyIQ — least-privilege database login
-- ===========================================================================
-- WHY: the bot currently connects as a login that is a member of db_owner and
-- maps to dbo. It can SELECT and DELETE every table in the database, including
-- the unrelated application tables (dbo.users, dbo.sessions, dbo.audit_logs …).
-- The "the application owns all SQL" guarantee is only as strong as the
-- credential behind it, so the runtime login must be able to do exactly one
-- thing: read the sbs_test schema.
--
-- RUN THIS AS: a server/database admin, against the MelaBilling database.
-- (In Azure SQL, connect to the MelaBilling database directly — not master —
--  because this creates a contained database user.)
--
-- AFTER RUNNING: set these in env/.env.*.user
--     AZURE_SQL_USERNAME=companyiq_app
--     AZURE_SQL_PASSWORD=<the password you set below>
--     AZURE_SQL_ADMIN_USERNAME=<the existing admin login>     -- db:seed / db:introspect only
--     AZURE_SQL_ADMIN_PASSWORD=<the existing admin password>  -- never used by the bot
-- ===========================================================================

-- 1. A contained user with its own password. No server login, no server roles.
--    Replace the password with a strong secret before running.
CREATE USER companyiq_app WITH PASSWORD = 'REPLACE-WITH-A-STRONG-PASSWORD';

-- 2. The ONLY grant: read the demo/product schema.
GRANT SELECT ON SCHEMA::sbs_test TO companyiq_app;

-- 3. Belt and braces: explicitly deny everything on the application schema, so
--    even a future accidental role grant cannot expose it.
DENY SELECT, INSERT, UPDATE, DELETE, EXECUTE ON SCHEMA::dbo TO companyiq_app;

-- 4. Deliberately NOT granted (leave it this way):
--      * no db_owner / db_datareader / db_datawriter / db_ddladmin membership
--      * no INSERT / UPDATE / DELETE anywhere — the bot only ever reads
--      * no CREATE / ALTER / DROP — seeding uses the admin credential instead
--      * no EXECUTE — there are no stored procedures to call

-- ===========================================================================
-- VERIFY (run while connected AS companyiq_app — all of these should hold)
-- ===========================================================================
-- SELECT USER_NAME();                                   -- companyiq_app (not dbo)
-- SELECT IS_ROLEMEMBER('db_owner');                     -- 0
-- SELECT IS_ROLEMEMBER('db_datareader');                -- 0
-- SELECT HAS_PERMS_BY_NAME('sbs_test.items','OBJECT','SELECT');   -- 1  (can read demo data)
-- SELECT HAS_PERMS_BY_NAME('sbs_test.items','OBJECT','DELETE');   -- 0  (cannot write)
-- SELECT HAS_PERMS_BY_NAME('dbo.users','OBJECT','SELECT');        -- 0  (cannot see the app's data)
-- SELECT * FROM dbo.users;                              -- must fail: permission denied
-- SELECT COUNT(*) FROM sbs_test.items;                  -- must succeed: 40

-- ===========================================================================
-- ROTATE / REVOKE
-- ===========================================================================
-- ALTER USER companyiq_app WITH PASSWORD = '<new>';
-- DROP USER companyiq_app;
