// Official entrypoint runs this only on an empty data volume.
for (const [database, username, password] of [
  [process.env.MONGO_DB_NAME, process.env.MONGO_APP_USERNAME, process.env.MONGO_APP_PASSWORD],
  [process.env.MONGO_TEST_DB_NAME, process.env.MONGO_TEST_USERNAME, process.env.MONGO_TEST_PASSWORD]
]) {
  db.getSiblingDB(database).createUser({
    user: username,
    pwd: password,
    roles: [{ role: 'readWrite', db: database }]
  });
}
