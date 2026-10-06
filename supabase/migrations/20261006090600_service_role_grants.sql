-- The service role needs explicit privileges.
--
-- Projects created with "Automatically expose new tables" off (the recommended
-- setting) give the Data API roles no default privileges. The earlier migrations grant
-- anon and authenticated exactly what they need, and the server-side pipeline,
-- variant cache, and sign tagging run as service_role, so grant it everything here.
-- service_role bypasses row-level security, so this widens nothing for clients.

grant all on all tables in schema public to service_role;
grant all on all sequences in schema public to service_role;

-- Tables created by later migrations get the same grant automatically.
alter default privileges in schema public grant all on tables to service_role;
alter default privileges in schema public grant all on sequences to service_role;
