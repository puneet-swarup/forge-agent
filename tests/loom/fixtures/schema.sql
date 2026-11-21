CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY,
  name TEXT
);

create view v_users as select * from users;

CREATE TABLE open_ended (
  id INTEGER PRIMARY KEY
