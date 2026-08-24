const admin = require('firebase-admin');

try { admin.app(); } catch (_) { admin.initializeApp({ projectId: 'sebabru-e5563' }); }
const db = admin.firestore();
db.settings({ databaseId: 'cursos' });

const VIDEOS = {
  luna: [
    'uha8ifistlY', 'BGOd7HjKgx4', 'M7gHaz60ryY', '9FI3vannH2Y',
    '045dqUaACGk', 'Xs7E_BJei0M', 'Gib61wKVZdk', '5G_up5yys34',
    'ENVdhyGJ_00', 'dfar0VIX400', '0TS6gjsb-OA', 'P_n0D_FCRts',
    'fXvwTWJOknY'
  ],
  signos: [
    'MRut1T_kKlQ', 'hYhuqAg_brU', 'vM9VjyvFaXo', 'pBKTJsxKX0M',
    '59UCPMbujd0', 'qcpP-A2CtS8', 'RC6vGZtu6SA', 'jLHY8QPPhTY',
    '0AlH7QkRdqo', 'RlJVvjHPAXE', '8vR5Kzk2A9c', '30kv8pZOFvk',
    'uvdrZPB5T6Y'
  ],
  casas: [
    '2D8-3QL40m8', 'Hhugy8uVrUU', '-x-X8yG6qfQ', '-8wkknKSOXo',
    'T8JQP0fGaXk', 'tDz2UvWNkgE', 'FzWEN65N7xw', 'JI-uFE5peT0',
    'GBsrxCpuMCM'
  ],
  tarot: [
    'UT-38kgcSIM', 'PjGZvbiuZDA', 'El-s3r6O62Q', 'HGrdBoLs_E4',
    'cvnAkxD1H2U', 'aB8TB9KVfUI', '-qjxncID7gc', '3oliOPXRxxU',
    '1B2W3AJgZdc', 'jFxWisBmIj0', 'pJW0wUB3YVI', 'I_QBCk-0SSA'
  ]
};

async function seed() {
  for (const [cursoId, videos] of Object.entries(VIDEOS)) {
    await db.collection('cursos').doc(cursoId).set({ videos });
    console.log(`✓ ${cursoId}: ${videos.length} videos`);
  }
  console.log('Done!');
  process.exit(0);
}

seed().catch(err => { console.error(err); process.exit(1); });
