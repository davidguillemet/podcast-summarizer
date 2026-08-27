import readline from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { createUser, getUserByUsername, listUsers, deleteUser } from '../src/db.js';
import { hashPassword } from '../src/services/auth.js';

function usage() {
    console.log(`Usage:
  node scripts/manage-users.js add <username>      Create a user (prompts for password)
  node scripts/manage-users.js list                List users
  node scripts/manage-users.js remove <username>   Delete a user`);
}

const [, , cmd, username] = process.argv;

if (cmd === 'add') {
    if (!username) {
        usage();
        process.exit(1);
    }
    if (getUserByUsername(username)) {
        console.error(`User "${username}" already exists.`);
        process.exit(1);
    }
    // One shared interface for both prompts — creating a fresh one per question
    // leaves piped (non-TTY) stdin unreadable for the second question.
    const rl = readline.createInterface({ input: stdin, output: stdout });
    const password = await rl.question('Password: ');
    const confirm = await rl.question('Confirm password: ');
    rl.close();
    if (!password || password !== confirm) {
        console.error('Passwords did not match (or were empty).');
        process.exit(1);
    }
    const { hash, salt } = hashPassword(password);
    createUser(username, hash, salt);
    console.log(`Created user "${username}".`);
} else if (cmd === 'list') {
    const users = listUsers();
    if (users.length === 0) console.log('No users yet — the app is unreachable until you add one.');
    for (const u of users) console.log(`${u.username}  (created ${u.created_at})`);
} else if (cmd === 'remove') {
    if (!username) {
        usage();
        process.exit(1);
    }
    console.log(deleteUser(username) ? `Removed "${username}".` : `No such user "${username}".`);
} else {
    usage();
    process.exit(cmd ? 1 : 0);
}
