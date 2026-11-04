try {
  const connection = new Mongo(
    'mongodb://127.0.0.1:27017/?directConnection=true&serverSelectionTimeoutMS=2000'
  );
  const admin = connection.getDB('admin');
  if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD))
    quit(1);
  const hello = admin.runCommand({ hello: 1 });
  quit(hello.isWritablePrimary && hello.setName === 'rs0' ? 0 : 1);
} catch {
  quit(1);
}
