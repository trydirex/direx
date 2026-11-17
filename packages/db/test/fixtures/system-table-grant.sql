-- Must fail the catalog check: direx_system holds a table privilege.
CREATE TABLE fx_granted (id int);
GRANT SELECT ON fx_granted TO direx_system;
