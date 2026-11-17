-- Must fail the catalog check: the app role owns a table.
CREATE TABLE fx_app_owned (id int);
ALTER TABLE fx_app_owned OWNER TO direx_app;
