// Credentials stay in process environment and never enter command arguments/logs.
let ready = false;
for (let attempt = 0; attempt < 90; attempt++) {
  try {
    const connection = new Mongo(
      'mongodb://mongo:27017/?directConnection=true&serverSelectionTimeoutMS=2000'
    );
    const admin = connection.getDB('admin');
    if (!admin.auth(process.env.MONGO_INITDB_ROOT_USERNAME, process.env.MONGO_INITDB_ROOT_PASSWORD))
      throw new Error('auth');
    let status;
    try {
      status = admin.runCommand({ replSetGetStatus: 1 });
    } catch (error) {
      if (error.code !== 94) throw error;
      status = { code: 94 };
    }
    if (status.code === 94) {
      const result = admin.runCommand({
        replSetInitiate: { _id: 'rs0', members: [{ _id: 0, host: 'mongo:27017' }] }
      });
      if (!result.ok && result.code !== 23) throw new Error('init');
    } else if (!status.ok) throw new Error('status');
    if (admin.runCommand({ hello: 1 }).isWritablePrimary) {
      ready = true;
      break;
    }
  } catch {
    /* bounded retry during official entrypoint/user initialization */
  }
  sleep(1000);
}
if (!ready) {
  print('Replica set bootstrap failed. Check Docker logs and persisted credential consistency.');
  quit(1);
}
print('Authenticated rs0 primary ready.');
