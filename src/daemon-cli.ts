import {daemonClient} from './daemon-client.js';

const command = process.argv[2] ?? 'status';
if (command !== 'status') {
  console.error('usage: fluentd status');
  process.exitCode = 1;
} else {
  void daemonClient.ping()
    .then(({pid}) => console.log(`fluentd healthy · pid ${pid}`))
    .catch(error => {
      console.error(error.message);
      process.exitCode = 1;
    });
}
