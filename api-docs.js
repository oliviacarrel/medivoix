/**
 * api-docs.js — Spécification OpenAPI 3.0 de l'API MediVox
 * Servie à /api/documentation (Swagger UI) et /api/docs.json (spec brute)
 */
export const spec = {
  openapi: '3.0.3',
  info: {
    title: 'MediVox API',
    version: '1.0.0',
    description: `
**MediVox** — Plateforme médicale SaaS pour le Centre de Libreville (CDL), Gabon.

Toutes les routes (sauf portail patient et FHIR metadata) nécessitent un **token JWT Bearer**.
Obtenez votre token via \`POST /api/auth/login\`.

**Environnement** : \`https://medivox.onrender.com\`
    `.trim(),
    contact: { name: 'CDL — Centre de Libreville', email: 'contact@cdl-gabon.ga' },
  },
  servers: [{ url: '', description: 'Serveur courant' }],
  security: [{ BearerAuth: [] }],

  components: {
    securitySchemes: {
      BearerAuth: { type: 'http', scheme: 'bearer', bearerFormat: 'JWT' },
    },
    schemas: {
      Error: {
        type: 'object',
        properties: {
          error: { type: 'string', example: 'Message d\'erreur' },
        },
      },
      User: {
        type: 'object',
        properties: {
          id:         { type: 'string', format: 'uuid' },
          email:      { type: 'string', format: 'email' },
          nom:        { type: 'string' },
          prenom:     { type: 'string' },
          rpps:       { type: 'string', nullable: true },
          specialite: { type: 'string', nullable: true },
          telephone:  { type: 'string', nullable: true },
          adresse:    { type: 'string', nullable: true },
          photo:      { type: 'string', nullable: true },
        },
      },
      Patient: {
        type: 'object',
        properties: {
          id:                      { type: 'string', format: 'uuid' },
          code_patient:            { type: 'string', nullable: true },
          nom:                     { type: 'string' },
          prenom:                  { type: 'string' },
          dateNaissance:           { type: 'string', format: 'date', nullable: true },
          sexe:                    { type: 'string', enum: ['M', 'F'] },
          telephone:               { type: 'string', nullable: true },
          telephone2:              { type: 'string', nullable: true },
          email:                   { type: 'string', nullable: true },
          adresse:                 { type: 'string', nullable: true },
          typeAssurance:           { type: 'string', nullable: true },
          numAssurance:            { type: 'string', nullable: true },
          assurance:               { type: 'string', nullable: true, example: 'CNAMGS' },
          convention:              { type: 'string', nullable: true, example: 'Agent Public 80%' },
          antecedents:             { type: 'string', nullable: true },
          allergies:               { type: 'string', nullable: true },
          traitements:             { type: 'string', nullable: true },
          groupe_sanguin:          { type: 'string', nullable: true },
          antecedents_familiaux:   { type: 'string', nullable: true },
          antecedents_chirurgicaux:{ type: 'string', nullable: true },
          vaccinations:            { type: 'string', nullable: true },
          facteurs_risque:         { type: 'string', nullable: true },
        },
      },
      Consultation: {
        type: 'object',
        properties: {
          id:             { type: 'string', format: 'uuid' },
          patientId:      { type: 'string', format: 'uuid' },
          userId:         { type: 'string', format: 'uuid' },
          motif:          { type: 'string' },
          date:           { type: 'string', format: 'date-time' },
          statut:         { type: 'string', enum: ['brouillon', 'validee', 'archivee'] },
          transcription:  { type: 'string', nullable: true },
          note:           { type: 'object', nullable: true },
          duration:       { type: 'integer', nullable: true, description: 'Durée en secondes' },
        },
      },
      Prescription: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          medicaments:  { type: 'array', items: { type: 'object', properties: {
            nom:    { type: 'string' },
            dose:   { type: 'string' },
            duree:  { type: 'string' },
            voie:   { type: 'string' },
          }}},
          conseils:     { type: 'string', nullable: true },
          createdAt:    { type: 'string', format: 'date-time' },
        },
      },
      LigneFac: {
        type: 'object',
        properties: {
          id:           { type: 'string', format: 'uuid' },
          consultationId: { type: 'string', nullable: true },
          patientId:    { type: 'string' },
          codeActe:     { type: 'string', nullable: true },
          libelleActe:  { type: 'string' },
          montant:      { type: 'number' },
          quantite:     { type: 'integer' },
          statut:       { type: 'string', enum: ['non_facture', 'facture', 'paye', 'annule'] },
          source:       { type: 'string', enum: ['auto', 'manuel'] },
        },
      },
      Honoraire: {
        type: 'object',
        properties: {
          id:         { type: 'string', format: 'uuid' },
          patientId:  { type: 'string' },
          montant:    { type: 'number' },
          statut:     { type: 'string', enum: ['en_attente', 'paye', 'annule'] },
          mode:       { type: 'string' },
          date:       { type: 'string', format: 'date' },
        },
      },
      Hospitalisation: {
        type: 'object',
        properties: {
          id:            { type: 'string', format: 'uuid' },
          patientId:     { type: 'string' },
          dateEntree:    { type: 'string', format: 'date' },
          dateSortie:    { type: 'string', nullable: true },
          motif:         { type: 'string' },
          chambre:       { type: 'string', nullable: true },
          statut:        { type: 'string', enum: ['en_cours', 'sortie', 'transfert'] },
          coutTotal:     { type: 'number' },
        },
      },
      NomenclatureActe: {
        type: 'object',
        properties: {
          code:                { type: 'string', example: 'NFS' },
          libelle:             { type: 'string', example: 'Numération Formule Sanguine' },
          categorie:           { type: 'string', example: 'Laboratoire' },
          montant_base:        { type: 'number', example: 8500 },
          tarif_cnamgs:        { type: 'number', nullable: true },
          tarif_ascoma:        { type: 'number', nullable: true },
          nomenclature_cnamgs: { type: 'string', nullable: true },
        },
      },
    },
  },

  tags: [
    { name: '🔐 Authentification',    description: 'Connexion, inscription, profil médecin' },
    { name: '📊 Tableau de bord',     description: 'KPIs et statistiques personnelles' },
    { name: '📅 Agenda',              description: 'Rendez-vous et planning' },
    { name: '👥 Patients',            description: 'Gestion du dossier patient' },
    { name: '🩺 Consultations',       description: 'Consultations, transcription IA, notes' },
    { name: '💊 Ordonnances',         description: 'Prescriptions médicamenteuses' },
    { name: '🧪 Ordres',              description: 'Ordres de biologie / imagerie et résultats' },
    { name: '💰 Honoraires',          description: 'Saisie et suivi des honoraires' },
    { name: '🧾 Facturation',         description: 'Lignes facturables, alertes, tableau de bord' },
    { name: '📋 Nomenclature',        description: 'Référentiel actes CDL + nomenclature officielle Gabon 2011' },
    { name: '🏥 Dossiers assurance',  description: 'Dossiers CNAMGS / ASCOMA / tiers payeurs' },
    { name: '🛏️ Hospitalisations',   description: 'Séjours hospitaliers et actes associés' },
    { name: '📈 Finances CDL',        description: 'Historique financier Jan–Mars 2026 (13 441 consultations)' },
    { name: '🏛️ CNAMGS',             description: 'Moteur de calcul remboursement — Nomenclature officielle 2011' },
    { name: '📡 Téléconsultation',    description: 'Sessions vidéo et liens patients' },
    { name: '🌐 Portail Patient',     description: 'Espace patient public (sans JWT médecin)' },
    { name: '💬 Messagerie',          description: 'Discussions internes + messages portail' },
    { name: '📱 Paiements Mobile',    description: 'Airtel Money / Moov Money' },
    { name: '🤖 Intelligence IA',     description: 'Épidémiologie, risques, prévisions, patients perdus' },
    { name: '📉 Analytics',           description: 'Analytiques consultations (période personnalisée)' },
    { name: '🔬 FHIR R4',            description: 'Interopérabilité — Patient, Encounter, Observation' },
    { name: '🔔 Alertes',            description: 'Notifications et alertes cliniques' },
    { name: '📄 Papeterie',          description: 'Génération PDF (arrêts, certificats, attestations)' },
    { name: '🔎 Audit',              description: 'Journal d\'audit des actions sensibles' },
    { name: '⚙️ Administration',     description: 'Backup S3, sites, utilisateurs' },
  ],

  paths: {

    // ══════════════════════════════════════════════
    // AUTH
    // ══════════════════════════════════════════════
    '/api/auth/login': {
      post: {
        tags: ['🔐 Authentification'], summary: 'Connexion médecin',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email','password'], properties: {
          email:    { type: 'string', format: 'email', example: 'dr.ekome@cdl-gabon.ga' },
          password: { type: 'string', minLength: 8, example: 'motdepasse123' },
        }}}}},
        responses: {
          200: { description: 'Token JWT + profil médecin', content: { 'application/json': { schema: { type: 'object', properties: {
            token: { type: 'string', description: 'JWT valable 12h' },
            user:  { $ref: '#/components/schemas/User' },
          }}}}},
          401: { description: 'Identifiants incorrects', content: { 'application/json': { schema: { $ref: '#/components/schemas/Error' }}}},
        },
      },
    },
    '/api/auth/register': {
      post: {
        tags: ['🔐 Authentification'], summary: 'Inscription nouveau médecin',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['email','password','nom','prenom'], properties: {
          email:     { type: 'string', format: 'email' },
          password:  { type: 'string', minLength: 8 },
          nom:       { type: 'string' },
          prenom:    { type: 'string' },
          rpps:      { type: 'string', nullable: true, description: 'Numéro RPPS / ordre médical' },
          specialite:{ type: 'string', nullable: true },
        }}}}},
        responses: {
          200: { description: 'Token JWT + profil créé' },
          400: { description: 'Champs manquants ou mot de passe trop court' },
          409: { description: 'Email déjà utilisé' },
        },
      },
    },
    '/api/auth/me': {
      get: {
        tags: ['🔐 Authentification'], summary: 'Profil du médecin connecté',
        responses: { 200: { description: 'Profil complet', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' }}}}},
      },
    },
    '/api/auth/profile': {
      put: {
        tags: ['🔐 Authentification'], summary: 'Mettre à jour le profil',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          nom: { type: 'string' }, prenom: { type: 'string' }, rpps: { type: 'string' },
          specialite: { type: 'string' }, telephone: { type: 'string' }, adresse: { type: 'string' },
          photo: { type: 'string', description: 'URL ou base64' },
        }}}}},
        responses: { 200: { description: 'Profil mis à jour', content: { 'application/json': { schema: { $ref: '#/components/schemas/User' }}}}},
      },
    },
    '/api/auth/password': {
      put: {
        tags: ['🔐 Authentification'], summary: 'Changer le mot de passe',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['current','next'], properties: {
          current: { type: 'string' },
          next:    { type: 'string', minLength: 8 },
        }}}}},
        responses: { 200: { description: 'OK' }, 400: { description: 'Mot de passe actuel incorrect' }},
      },
    },

    // ══════════════════════════════════════════════
    // DASHBOARD
    // ══════════════════════════════════════════════
    '/api/dashboard': {
      get: {
        tags: ['📊 Tableau de bord'], summary: 'KPIs personnalisés du médecin',
        responses: { 200: { description: 'Statistiques : patients, consultations semaine, honoraires mois, alertes', content: { 'application/json': { schema: { type: 'object', properties: {
          totalPatients:    { type: 'integer' },
          consultsWeek:     { type: 'integer' },
          honorairesMois:   { type: 'number' },
          consultations:    { type: 'array', items: { $ref: '#/components/schemas/Consultation' }},
          agenda:           { type: 'array' },
          alertes:          { type: 'array' },
        }}}}}},
      },
    },

    // ══════════════════════════════════════════════
    // AGENDA
    // ══════════════════════════════════════════════
    '/api/agenda': {
      get: {
        tags: ['📅 Agenda'], summary: 'Liste des rendez-vous',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }, description: 'Date début (défaut: aujourd\'hui)' },
          { name: 'to',   in: 'query', schema: { type: 'string', format: 'date' }, description: 'Date fin' },
        ],
        responses: { 200: { description: 'Liste des RDV du médecin' }},
      },
      post: {
        tags: ['📅 Agenda'], summary: 'Créer un rendez-vous',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientId','date','heure'], properties: {
          patientId: { type: 'string', format: 'uuid' },
          date:      { type: 'string', format: 'date' },
          heure:     { type: 'string', example: '09:30' },
          motif:     { type: 'string' },
          type:      { type: 'string', enum: ['consultation','teleconsultation','urgence'] },
          notes:     { type: 'string' },
        }}}}},
        responses: { 200: { description: 'RDV créé' }, 409: { description: 'Créneau déjà occupé' }},
      },
    },
    '/api/agenda/{id}': {
      put: {
        tags: ['📅 Agenda'], summary: 'Modifier un rendez-vous',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object' }}}},
        responses: { 200: { description: 'RDV mis à jour' }},
      },
      delete: {
        tags: ['📅 Agenda'], summary: 'Supprimer un rendez-vous',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Supprimé' }},
      },
    },

    // ══════════════════════════════════════════════
    // PATIENTS
    // ══════════════════════════════════════════════
    '/api/patients': {
      get: {
        tags: ['👥 Patients'], summary: 'Recherche patients du médecin',
        parameters: [
          { name: 'q',     in: 'query', schema: { type: 'string' }, description: 'Recherche nom / prénom / téléphone' },
          { name: 'limit', in: 'query', schema: { type: 'integer', default: 200 } },
        ],
        responses: { 200: { description: 'Liste de patients', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Patient' }}}}}},
      },
      post: {
        tags: ['👥 Patients'], summary: 'Créer un nouveau patient',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Patient' }}}},
        responses: { 200: { description: 'Patient créé', content: { 'application/json': { schema: { $ref: '#/components/schemas/Patient' }}}}},
      },
    },
    '/api/patients/{id}': {
      get: {
        tags: ['👥 Patients'], summary: 'Dossier complet d\'un patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string', format: 'uuid' }}],
        responses: { 200: { description: 'Patient + historique consultations', content: { 'application/json': { schema: {
          allOf: [{ $ref: '#/components/schemas/Patient' }, { type: 'object', properties: { consultations: { type: 'array' }}}],
        }}}}, 404: { description: 'Patient non trouvé' }},
      },
      put: {
        tags: ['👥 Patients'], summary: 'Mettre à jour le dossier patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Patient' }}}},
        responses: { 200: { description: 'Patient mis à jour' }, 404: { description: 'Non trouvé' }},
      },
    },
    '/api/all-patients': {
      get: {
        tags: ['👥 Patients'], summary: 'Registre complet CDL (67 000+ patients importés)',
        parameters: [
          { name: 'q',         in: 'query', schema: { type: 'string' }, description: 'Recherche nom / prénom / code / téléphone' },
          { name: 'assurance', in: 'query', schema: { type: 'string' }, description: 'Filtrer par assurance (CNAMGS, ASCOMA, Aucune…)' },
          { name: 'page',      in: 'query', schema: { type: 'integer', default: 0 } },
          { name: 'limit',     in: 'query', schema: { type: 'integer', default: 50, maximum: 200 } },
        ],
        responses: { 200: { description: 'Registre paginé avec liste des assurances disponibles', content: { 'application/json': { schema: { type: 'object', properties: {
          rows:       { type: 'array', items: { $ref: '#/components/schemas/Patient' }},
          total:      { type: 'integer' },
          page:       { type: 'integer' },
          limit:      { type: 'integer' },
          assurances: { type: 'array', items: { type: 'string' }},
        }}}}}},
      },
    },
    '/api/patients/{id}/360': {
      get: {
        tags: ['👥 Patients'], summary: 'Vue 360° — dossier enrichi complet',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Patient + consultations + ordonnances + résultats + hospitalisations + dossiers assurance' }},
      },
    },
    '/api/patients/{id}/dossier/pdf': {
      get: {
        tags: ['👥 Patients'], summary: 'Export PDF du dossier patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'PDF binaire', content: { 'application/pdf': {} }}},
      },
    },
    '/api/patients/{id}/parcours': {
      get: {
        tags: ['👥 Patients'], summary: 'Parcours de soins chronologique',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Timeline : consultations, ordonnances, ordres, hospitalisations' }},
      },
    },
    '/api/patients/{id}/dossier-status': {
      get: {
        tags: ['👥 Patients'], summary: 'Complétude du dossier patient (%)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Score de complétude et champs manquants', content: { 'application/json': { schema: { type: 'object', properties: {
          score:   { type: 'number', example: 72 },
          missing: { type: 'array', items: { type: 'string' }},
        }}}}}},
      },
    },
    '/api/patients/{id}/portail/code': {
      post: {
        tags: ['👥 Patients'], summary: 'Générer / envoyer le code d\'accès portail patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Code généré et enregistré' }},
      },
    },
    '/api/patients/{id}/consentements': {
      post: {
        tags: ['👥 Patients'], summary: 'Enregistrer un consentement patient (portail)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        security: [{ BearerAuth: [] }],
        responses: { 200: { description: 'Consentement enregistré' }},
      },
    },

    // ══════════════════════════════════════════════
    // CONSULTATIONS
    // ══════════════════════════════════════════════
    '/api/consultations': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Créer une consultation',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientId'], properties: {
          patientId: { type: 'string', format: 'uuid' },
          motif:     { type: 'string' },
          date:      { type: 'string', format: 'date-time' },
        }}}}},
        responses: { 200: { description: 'Consultation créée', content: { 'application/json': { schema: { $ref: '#/components/schemas/Consultation' }}}}},
      },
    },
    '/api/consultations/{id}': {
      get: {
        tags: ['🩺 Consultations'], summary: 'Détail d\'une consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Consultation avec note déchiffrée' }},
      },
      delete: {
        tags: ['🩺 Consultations'], summary: 'Supprimer une consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Supprimée' }},
      },
    },
    '/api/consultations/{id}/transcribe': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Transcrire un enregistrement audio (Whisper AI)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'multipart/form-data': { schema: { type: 'object', properties: {
          audio: { type: 'string', format: 'binary', description: 'Fichier audio (webm, mp3, wav, m4a…)' },
        }}}}},
        responses: { 200: { description: 'Transcription texte sauvegardée', content: { 'application/json': { schema: { type: 'object', properties: {
          transcription: { type: 'string' },
        }}}}}},
      },
    },
    '/api/consultations/{id}/generate-note': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Générer la note médicale structurée (GPT-4)',
        description: 'À partir de la transcription, génère une note SOAP complète : anamnèse, examen, diagnostic, plan.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Note structurée JSON + version texte', content: { 'application/json': { schema: { type: 'object', properties: {
          note: { type: 'object', description: 'Note SOAP structurée' },
        }}}}}},
      },
    },
    '/api/consultations/{id}/validate-note': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Valider et signer la note médicale',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Statut → validee' }},
      },
    },
    '/api/consultations/{id}/update-transcription': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Sauvegarder la transcription editée manuellement',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          transcription: { type: 'string' },
        }}}}},
        responses: { 200: { description: 'Sauvegardée' }},
      },
    },
    '/api/consultations/{id}/constantes': {
      put: {
        tags: ['🩺 Consultations'], summary: 'Enregistrer les constantes vitales',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          poids:           { type: 'number' },
          taille:          { type: 'number' },
          tension_sys:     { type: 'number' },
          tension_dia:     { type: 'number' },
          temperature:     { type: 'number' },
          frequence_card:  { type: 'number' },
          frequence_resp:  { type: 'number' },
          saturation_o2:   { type: 'number' },
          glycemie:        { type: 'number' },
        }}}}},
        responses: { 200: { description: 'Constantes mises à jour' }},
      },
    },
    '/api/consultations/{id}/auto-facturation': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Détecter automatiquement les actes facturables',
        description: 'Analyse la note médicale et la transcription pour proposer des lignes facturables (NFS, ECG, biopsie…).',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Lignes facturables créées', content: { 'application/json': { schema: { type: 'object', properties: {
          detected: { type: 'integer', description: 'Nombre d\'actes détectés' },
          lignes:   { type: 'array', items: { $ref: '#/components/schemas/LigneFac' }},
        }}}}}},
      },
    },
    '/api/consultations/{id}/completude': {
      get: {
        tags: ['🩺 Consultations'], summary: 'Évaluer la complétude de la consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Score et champs manquants', content: { 'application/json': { schema: { type: 'object', properties: {
          score:   { type: 'number' },
          missing: { type: 'array', items: { type: 'string' }},
        }}}}}},
      },
    },
    '/api/consultations/{id}/protocol': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Appliquer un protocole clinique (HTA, diabète, paludisme…)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          protocol: { type: 'string', example: 'paludisme' },
        }}}}},
        responses: { 200: { description: 'Protocole appliqué, ordres créés si applicable' }},
      },
    },
    '/api/consultations/{id}/resume-patient': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Générer le résumé lisible par le patient (IA)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Texte simplifié en français', content: { 'application/json': { schema: { type: 'object', properties: { resume: { type: 'string' }}}}}},
      }},
    },
    '/api/consultations/{id}/timing': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Enregistrer la durée de la consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: { duration: { type: 'integer', description: 'Durée en secondes' }}}}}},
        responses: { 200: { description: 'OK' }},
      },
    },
    '/api/consultations/{id}/send-email': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Envoyer la note médicale par e-mail',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Email envoyé' }, 503: { description: 'SMTP non configuré' }},
      },
    },
    '/api/consultations/{id}/pdf': {
      get: {
        tags: ['🩺 Consultations'], summary: 'Export PDF de la note médicale',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'PDF de la consultation', content: { 'application/pdf': {} }}},
      },
    },
    '/api/tts': {
      post: {
        tags: ['🩺 Consultations'], summary: 'Synthèse vocale (Text-to-Speech)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          text:  { type: 'string' },
          voice: { type: 'string', enum: ['alloy','echo','fable','onyx','nova','shimmer'], default: 'nova' },
        }}}}},
        responses: { 200: { description: 'Audio MP3', content: { 'audio/mpeg': {} }}},
      },
    },

    // ══════════════════════════════════════════════
    // ORDONNANCES
    // ══════════════════════════════════════════════
    '/api/patients/{id}/prescriptions': {
      get: {
        tags: ['💊 Ordonnances'], summary: 'Historique ordonnances d\'un patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Liste des ordonnances', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Prescription' }}}}}},
      },
    },
    '/api/consultations/{id}/prescription': {
      get: {
        tags: ['💊 Ordonnances'], summary: 'Ordonnance de la consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Prescription JSON' }},
      },
      put: {
        tags: ['💊 Ordonnances'], summary: 'Créer / modifier l\'ordonnance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Prescription' }}}},
        responses: { 200: { description: 'Ordonnance sauvegardée' }},
      },
    },
    '/api/consultations/{id}/prescription/pdf': {
      get: {
        tags: ['💊 Ordonnances'], summary: 'Export PDF de l\'ordonnance',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'PDF ordonance formaté CDL', content: { 'application/pdf': {} }}},
      },
    },

    // ══════════════════════════════════════════════
    // ORDRES (BIOLOGIE / IMAGERIE)
    // ══════════════════════════════════════════════
    '/api/ordres': {
      post: {
        tags: ['🧪 Ordres'], summary: 'Créer un ordre (biologie / imagerie)',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientId','type','libelle'], properties: {
          patientId:    { type: 'string' },
          consultationId: { type: 'string', nullable: true },
          type:         { type: 'string', enum: ['biologie','imagerie','autre'] },
          libelle:      { type: 'string', example: 'NFS + CRP + Glycémie' },
          urgence:      { type: 'boolean', default: false },
          notes:        { type: 'string' },
        }}}}},
        responses: { 200: { description: 'Ordre créé' }},
      },
    },
    '/api/patients/{id}/ordres': {
      get: {
        tags: ['🧪 Ordres'], summary: 'Ordres d\'un patient',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Liste des ordres avec statut et résultats' }},
      },
    },
    '/api/consultations/{id}/ordres': {
      get: {
        tags: ['🧪 Ordres'], summary: 'Ordres liés à une consultation',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Ordres de la consultation' }},
      },
    },
    '/api/ordres/{id}/statut': {
      put: {
        tags: ['🧪 Ordres'], summary: 'Mettre à jour le statut d\'un ordre',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          statut: { type: 'string', enum: ['en_attente','recu','partiel','complet','annule'] },
        }}}}},
        responses: { 200: { description: 'Statut mis à jour' }},
      },
    },
    '/api/ordres/{id}/resultats': {
      put: {
        tags: ['🧪 Ordres'], summary: 'Saisir les résultats d\'un ordre',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          resultats: { type: 'object', description: 'Résultats JSON ou texte libre' },
          commentaire: { type: 'string' },
        }}}}},
        responses: { 200: { description: 'Résultats enregistrés' }},
      },
    },
    '/api/patients/{id}/imaging': {
      get: {
        tags: ['🧪 Ordres'], summary: 'Images DICOM via PostDICOM',
        description: 'Retourne les liens PostDICOM des examens d\'imagerie du patient.',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Liste des études DICOM avec liens de visualisation' }},
      },
    },

    // ══════════════════════════════════════════════
    // HONORAIRES
    // ══════════════════════════════════════════════
    '/api/honoraires/dashboard': {
      get: {
        tags: ['💰 Honoraires'], summary: 'Tableau de bord financier du médecin',
        responses: { 200: { description: 'CA, encaissé, impayé, évolution mensuelle' }},
      },
    },
    '/api/honoraires': {
      get: {
        tags: ['💰 Honoraires'], summary: 'Liste des honoraires',
        parameters: [
          { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'statut', in: 'query', schema: { type: 'string' }},
        ],
        responses: { 200: { description: 'Honoraires filtrés', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/Honoraire' }}}}}},
      },
      post: {
        tags: ['💰 Honoraires'], summary: 'Saisir un honoraire',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Honoraire' }}}},
        responses: { 200: { description: 'Honoraire créé' }},
      },
    },
    '/api/honoraires/{id}': {
      put:    { tags: ['💰 Honoraires'], summary: 'Modifier un honoraire', parameters: [{ name:'id', in:'path', required:true, schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Honoraire'}}}}, responses:{200:{description:'Mis à jour'}}},
      delete: { tags: ['💰 Honoraires'], summary: 'Supprimer un honoraire', parameters: [{ name:'id', in:'path', required:true, schema:{type:'string'}}], responses:{200:{description:'Supprimé'}}},
    },
    '/api/honoraires/export': {
      get: {
        tags: ['💰 Honoraires'], summary: 'Export CSV des honoraires',
        parameters: [
          { name: 'from', in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'to',   in: 'query', schema: { type: 'string', format: 'date' }},
        ],
        responses: { 200: { description: 'Fichier CSV', content: { 'text/csv': {} }}},
      },
    },
    '/api/tarifs': {
      get: {
        tags: ['💰 Honoraires'], summary: 'Tarifs personnalisés du médecin',
        responses: { 200: { description: 'Tarifs par type d\'acte' }},
      },
      put: {
        tags: ['💰 Honoraires'], summary: 'Mettre à jour les tarifs',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', description: 'Map typeActe → montant' }}}},
        responses: { 200: { description: 'Tarifs mis à jour' }},
      },
    },

    // ══════════════════════════════════════════════
    // FACTURATION
    // ══════════════════════════════════════════════
    '/api/lignes-facturables': {
      get: {
        tags: ['🧾 Facturation'], summary: 'Toutes les lignes facturables du médecin',
        parameters: [
          { name: 'statut', in: 'query', schema: { type: 'string', enum: ['non_facture','facture','paye','annule'] }},
          { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' }},
        ],
        responses: { 200: { description: 'Lignes facturables', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/LigneFac' }}}}}},
      },
      post: {
        tags: ['🧾 Facturation'], summary: 'Créer une ligne facturable manuellement',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/LigneFac' }}}},
        responses: { 200: { description: 'Ligne créée' }},
      },
    },
    '/api/lignes-facturables/{id}': {
      put:    { tags:['🧾 Facturation'], summary:'Modifier une ligne', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/LigneFac'}}}}, responses:{200:{description:'Mise à jour'}}},
      delete: { tags:['🧾 Facturation'], summary:'Supprimer une ligne', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Supprimée'}}},
    },
    '/api/patients/{id}/lignes-facturables': {
      get: { tags:['🧾 Facturation'], summary:'Lignes facturables d\'un patient', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Lignes'}}},
    },
    '/api/consultations/{id}/lignes-facturables': {
      get: { tags:['🧾 Facturation'], summary:'Lignes facturables d\'une consultation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Lignes'}}},
    },
    '/api/facturation/alertes': {
      get: { tags:['🧾 Facturation'], summary:'Alertes de facturation (actes non facturés > 7j)', responses:{200:{description:'Alertes avec montant potentiel'}}},
    },
    '/api/facturation/dashboard': {
      get: { tags:['🧾 Facturation'], summary:'Tableau de bord facturation', responses:{200:{description:'CA à facturer, taux de facturation, top actes'}}},
    },

    // ══════════════════════════════════════════════
    // NOMENCLATURE
    // ══════════════════════════════════════════════
    '/api/nomenclature': {
      get: {
        tags: ['📋 Nomenclature'], summary: 'Recherche actes — Tarification CDL',
        description: 'Référentiel issu des fichiers Excel CDL : ~1 000 actes avec tarifs CNAMGS, ASCOMA.',
        parameters: [
          { name: 'q',        in: 'query', schema: { type: 'string' }, description: 'Recherche libellé' },
          { name: 'categorie',in: 'query', schema: { type: 'string' }, description: 'Filtrer par catégorie (Laboratoire, Imagerie…)' },
        ],
        responses: { 200: { description: 'Actes correspondants', content: { 'application/json': { schema: { type: 'array', items: { $ref: '#/components/schemas/NomenclatureActe' }}}}}},
      },
    },
    '/api/nomenclature/officielle': {
      get: {
        tags: ['📋 Nomenclature'], summary: 'Nomenclature officielle Gabon 2011 — enrichie CNAMGS',
        description: 'Retourne les actes avec calcul auto des parts CNAMGS (80% et 90%).',
        parameters: [
          { name: 'q',        in: 'query', schema: { type: 'string' }},
          { name: 'categorie',in: 'query', schema: { type: 'string' }},
        ],
        responses: { 200: { description: 'Actes + cnamgs_80pct + cnamgs_90pct', content: { 'application/json': { schema: { type: 'array', items: {
          allOf: [{ $ref: '#/components/schemas/NomenclatureActe' }, { type:'object', properties: {
            cnamgs_80pct: { type:'number', nullable:true },
            cnamgs_90pct: { type:'number', nullable:true },
          }}],
        }}}}}},
      },
    },

    // ══════════════════════════════════════════════
    // DOSSIERS ASSURANCE
    // ══════════════════════════════════════════════
    '/api/dossiers-assurance': {
      post: {
        tags: ['🏥 Dossiers assurance'], summary: 'Créer un dossier de prise en charge',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientId','caisse'], properties: {
          patientId:       { type: 'string' },
          caisse:          { type: 'string', example: 'CNAMGS' },
          reference:       { type: 'string', nullable: true },
          montantDemande:  { type: 'number' },
          consultationIds: { type: 'array', items: { type: 'string' }},
          notes:           { type: 'string' },
        }}}}},
        responses: { 200: { description: 'Dossier créé' }},
      },
      get: {
        tags: ['🏥 Dossiers assurance'], summary: 'Dossiers assurance du médecin',
        parameters: [
          { name: 'statut', in: 'query', schema: { type: 'string', enum: ['constitution','soumis','en_attente','accepte','rejete','paye'] }},
        ],
        responses: { 200: { description: 'Dossiers filtrés' }},
      },
    },
    '/api/patients/{id}/dossiers-assurance': {
      get: { tags:['🏥 Dossiers assurance'], summary:'Dossiers assurance d\'un patient', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Dossiers'}}},
    },
    '/api/dossiers-assurance/{id}': {
      put: {
        tags: ['🏥 Dossiers assurance'], summary: 'Mettre à jour un dossier (statut, montant accordé…)',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', properties: {
          statut:          { type: 'string' },
          montantAccorde:  { type: 'number', nullable: true },
          motifRejet:      { type: 'string', nullable: true },
          actionCorrective:{ type: 'string', nullable: true },
          datePaiement:    { type: 'string', format: 'date', nullable: true },
        }}}}},
        responses: { 200: { description: 'Dossier mis à jour' }},
      },
    },

    // ══════════════════════════════════════════════
    // HOSPITALISATIONS
    // ══════════════════════════════════════════════
    '/api/hospitalisations': {
      post: {
        tags: ['🛏️ Hospitalisations'], summary: 'Créer une hospitalisation',
        requestBody: { required: true, content: { 'application/json': { schema: { $ref: '#/components/schemas/Hospitalisation' }}}},
        responses: { 200: { description: 'Hospitalisation créée' }},
      },
      get: {
        tags: ['🛏️ Hospitalisations'], summary: 'Liste des hospitalisations',
        parameters: [{ name: 'statut', in: 'query', schema: { type: 'string' }}],
        responses: { 200: { description: 'Hospitalisations' }},
      },
    },
    '/api/hospitalisations/{id}': {
      get: { tags:['🛏️ Hospitalisations'], summary:'Détail d\'une hospitalisation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Hospitalisation + actes'}}},
      put: { tags:['🛏️ Hospitalisations'], summary:'Mettre à jour (sortie, chambre…)', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{$ref:'#/components/schemas/Hospitalisation'}}}}, responses:{200:{description:'Mise à jour'}}},
    },
    '/api/hospitalisations/{id}/actes': {
      post: { tags:['🛏️ Hospitalisations'], summary:'Ajouter un acte à l\'hospitalisation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{libelle:{type:'string'},montant:{type:'number'},date:{type:'string'}}}}}}  , responses:{200:{description:'Acte ajouté'}}},
      get:  { tags:['🛏️ Hospitalisations'], summary:'Actes de l\'hospitalisation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Liste des actes'}}},
    },
    '/api/hospitalisations/{id}/pdf': {
      get: { tags:['🛏️ Hospitalisations'], summary:'Export PDF du séjour', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'PDF',content:{'application/pdf':{}}}}},
    },

    // ══════════════════════════════════════════════
    // FINANCES CDL
    // ══════════════════════════════════════════════
    '/api/finances/stats': {
      get: {
        tags: ['📈 Finances CDL'], summary: 'KPIs financiers historiques (Jan–Mars 2026)',
        description: 'Source : 13 441 consultations importées depuis le registre CDL. CA, recouvrement, médecins, assurances, diagnostics.',
        responses: { 200: { description: 'Statistiques complètes', content: { 'application/json': { schema: { type: 'object', properties: {
          global: { type: 'object', properties: {
            total_consultations: { type: 'integer', example: 13441 },
            ca_total:            { type: 'number',  example: 499695000 },
            ca_paye:             { type: 'number',  example: 210313280 },
            reste_total:         { type: 'number',  example: 289381720 },
            taux_recouvrement:   { type: 'number',  example: 42.1 },
            nb_medecins:         { type: 'integer', example: 57 },
            nb_patients_uniq:    { type: 'integer' },
            montant_moyen:       { type: 'number',  example: 49226 },
          }},
          byMonth:      { type: 'array', items: { type: 'object', properties: { mois:{type:'string'}, consultations:{type:'integer'}, ca_total:{type:'number'}, ca_paye:{type:'number'}, reste:{type:'number'}, taux_recouvrement:{type:'number'}}}},
          byAssurance:  { type: 'array' },
          byMedecin:    { type: 'array' },
          topDiags:     { type: 'array', items: { type:'object', properties: { diagnostic:{type:'string'}, occurrences:{type:'integer'}, pct:{type:'number'}}}},
          distMontants: { type: 'array' },
        }}}}}},
      },
    },
    '/api/finances/impayes': {
      get: {
        tags: ['📈 Finances CDL'], summary: 'Tableau des créances impayées par convention',
        responses: { 200: { description: 'Top 50 conventions avec montant restant dû', content: { 'application/json': { schema: { type: 'array', items: { type: 'object', properties: {
          assurance:     { type: 'string' },
          convention:    { type: 'string' },
          nb_dossiers:   { type: 'integer' },
          montant_total: { type: 'number' },
          montant_paye:  { type: 'number' },
          reste:         { type: 'number' },
          taux:          { type: 'number' },
        }}}}}}},
      },
    },

    // ══════════════════════════════════════════════
    // CNAMGS
    // ══════════════════════════════════════════════
    '/api/cnamgs/tarifs': {
      get: {
        tags: ['🏛️ CNAMGS'], summary: 'Référentiel complet tarifs conventionnés + lettres-clés',
        description: 'Source : Nomenclature officielle Gabon 2011 — Annexes 1, 2, 3. Secteur privé, jours ouvrables.',
        responses: { 200: { description: 'Tarifs et lettres-clés', content: { 'application/json': { schema: { type: 'object', properties: {
          tarifs: { type: 'object', description: 'Map code → {tarif_prive, tarif_conv, libelle}', example: {
            C:  { tarif_prive:15000, tarif_conv:7500,  libelle:'Consultation généraliste' },
            Cs: { tarif_prive:20000, tarif_conv:10000, libelle:'Consultation spécialiste' },
          }},
          lettres_cles: { type: 'object', description: 'Map lettre → {valeur FCFA, description}', example: {
            B:  { valeur:125,  desc:'Biologie médicale' },
            KC: { valeur:1300, desc:'Chirurgie spécialiste' },
            Z:  { valeur:1000, desc:'Radiodiagnostic ionisant' },
          }},
        }}}}}},
      },
    },
    '/api/cnamgs/calcul': {
      get: {
        tags: ['🏛️ CNAMGS'], summary: 'Calculer le remboursement CNAMGS',
        description: 'Retourne la décomposition complète : prise en charge CNAMGS, ticket modérateur, dépassement d\'honoraires.',
        parameters: [
          { name: 'acte',      in: 'query', schema: { type: 'string', enum: ['C','Cs','CNPSY','CPr','C_DENT','SF','AMI','CDt','HOSP','REA','ACC'], default: 'C' }, description: 'Code de l\'acte' },
          { name: 'affection', in: 'query', schema: { type: 'string', enum: ['courante','ald','grossesse'], default: 'courante' }, description: 'Type d\'affection' },
          { name: 'prix',      in: 'query', schema: { type: 'number' }, description: 'Prix facturé (optionnel, défaut = tarif privé standard)' },
        ],
        responses: { 200: { description: 'Décomposition financière', content: { 'application/json': { schema: { type: 'object', properties: {
          acte:                   { type: 'string', example: 'Consultation généraliste' },
          type_affection:         { type: 'string', example: 'courante' },
          tarif_prive:            { type: 'number', example: 15000 },
          tarif_conventionne:     { type: 'number', example: 7500, description: 'Référence CNAMGS' },
          cnamgs_part:            { type: 'number', example: 6000, description: '80% du tarif conventionné' },
          ticket_moderateur:      { type: 'number', example: 1500, description: '20% à la charge de l\'assuré' },
          depassement_honoraires: { type: 'number', example: 7500, description: 'Au-delà du conventionné' },
          patient_total:          { type: 'number', example: 9000, description: 'Ticket + dépassement' },
        }}}}}, 404: { description: 'Code acte inconnu' }},
      },
    },

    // ══════════════════════════════════════════════
    // TÉLÉCONSULTATION
    // ══════════════════════════════════════════════
    '/api/teleconsultations': {
      post: {
        tags: ['📡 Téléconsultation'], summary: 'Créer une session de téléconsultation',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientId'], properties: {
          patientId: { type: 'string' },
          date:      { type: 'string', format: 'date-time' },
          notes:     { type: 'string', nullable: true },
        }}}}},
        responses: { 200: { description: 'Session créée avec lien patient (portail)', content: { 'application/json': { schema: { type: 'object', properties: {
          id:        { type: 'string' },
          lien:      { type: 'string', description: 'URL portail patient' },
          nom:       { type: 'string' },
          prenom:    { type: 'string' },
          telephone: { type: 'string', nullable: true },
        }}}}}},
      },
      get: {
        tags: ['📡 Téléconsultation'], summary: 'Historique des téléconsultations',
        responses: { 200: { description: 'Liste avec téléphone patient pour WhatsApp' }},
      },
    },

    // ══════════════════════════════════════════════
    // PORTAIL PATIENT (public)
    // ══════════════════════════════════════════════
    '/api/portal/auth': {
      post: {
        tags: ['🌐 Portail Patient'], summary: 'Authentification patient (code + téléphone)',
        description: '**Public — pas de JWT médecin requis.** Rate-limit : 10 req/15min.',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['telephone','code'], properties: {
          telephone: { type: 'string', example: '077123456' },
          code:      { type: 'string', example: '4821' },
        }}}}},
        responses: {
          200: { description: 'Token portail (24h)', content: { 'application/json': { schema: { type: 'object', properties: {
            token:   { type: 'string' },
            patient: { $ref: '#/components/schemas/Patient' },
          }}}}},
          401: { description: 'Code ou téléphone incorrect' },
        },
      },
    },
    '/api/portal/disponibilites': {
      get: {
        tags: ['🌐 Portail Patient'], summary: 'Créneaux disponibles pour RDV',
        description: 'Public — retourne les créneaux libres par médecin.',
        security: [],
        parameters: [
          { name: 'date',    in: 'query', schema: { type: 'string', format: 'date' }, required: true },
          { name: 'userId',  in: 'query', schema: { type: 'string' }, description: 'ID médecin (optionnel)' },
        ],
        responses: { 200: { description: 'Créneaux disponibles par médecin' }},
      },
    },
    '/api/portal/rdv': {
      post: {
        tags: ['🌐 Portail Patient'], summary: 'Réserver un rendez-vous depuis le portail',
        description: 'Public. Vérifie les conflits de créneaux (anti double-booking).',
        security: [],
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['patientNom','patientPrenom','date','heure','userId'], properties: {
          patientNom:    { type: 'string' },
          patientPrenom: { type: 'string' },
          telephone:     { type: 'string' },
          date:          { type: 'string', format: 'date' },
          heure:         { type: 'string', example: '09:30' },
          userId:        { type: 'string', description: 'ID du médecin' },
          motif:         { type: 'string' },
        }}}}},
        responses: {
          200: { description: 'RDV réservé', content: { 'application/json': { schema: { type: 'object', properties: { id:{type:'string'} }}}}},
          409: { description: 'Créneau déjà occupé' },
        },
      },
    },
    '/api/portal/consultations': {
      get: { tags:['🌐 Portail Patient'], summary:'Consultations du patient connecté', description:'Nécessite token portail.', responses:{200:{description:'Consultations du patient'}}},
    },
    '/api/portal/prescriptions': {
      get: { tags:['🌐 Portail Patient'], summary:'Ordonnances du patient', responses:{200:{description:'Ordonnances actives'}}},
    },
    '/api/portal/resultats': {
      get: { tags:['🌐 Portail Patient'], summary:'Résultats d\'examens', responses:{200:{description:'Résultats disponibles'}}},
    },
    '/api/portal/messages': {
      get:  { tags:['🌐 Portail Patient'], summary:'Messages patient → médecin', responses:{200:{description:'Fil de messages'}}},
      post: { tags:['🌐 Portail Patient'], summary:'Envoyer un message au médecin', requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{message:{type:'string'}}}}}}, responses:{200:{description:'Message envoyé'}}},
    },
    '/api/patients/{id}/portal-messages': {
      get:  { tags:['🌐 Portail Patient'], summary:'Messages portail d\'un patient (vue médecin)', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Messages'}}},
      post: { tags:['🌐 Portail Patient'], summary:'Répondre au patient depuis le dossier', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{message:{type:'string'}}}}}}, responses:{200:{description:'Message envoyé'}}},
    },

    // ══════════════════════════════════════════════
    // MESSAGERIE INTERNE
    // ══════════════════════════════════════════════
    '/api/patients/{id}/discussions': {
      get:  { tags:['💬 Messagerie'], summary:'Discussions liées à un patient', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Discussions'}}},
      post: { tags:['💬 Messagerie'], summary:'Créer une discussion', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{sujet:{type:'string'}}}}}}, responses:{200:{description:'Discussion créée'}}},
    },
    '/api/discussions/{id}/messages': {
      get:  { tags:['💬 Messagerie'], summary:'Messages d\'une discussion', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Messages'}}},
      post: { tags:['💬 Messagerie'], summary:'Envoyer un message', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{contenu:{type:'string'}}}}}}, responses:{200:{description:'Message envoyé'}}},
    },
    '/api/discussions/{id}/upload': {
      post: { tags:['💬 Messagerie'], summary:'Joindre un fichier à une discussion', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'multipart/form-data':{schema:{type:'object',properties:{fichier:{type:'string',format:'binary'}}}}}}, responses:{200:{description:'Fichier joint'}}},
    },
    '/api/discussions/{id}/invite': {
      post: { tags:['💬 Messagerie'], summary:'Inviter un autre médecin', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{userId:{type:'string'}}}}}}, responses:{200:{description:'Invitation envoyée'}}},
    },

    // ══════════════════════════════════════════════
    // PAIEMENTS MOBILE
    // ══════════════════════════════════════════════
    '/api/paiements-mobile': {
      post: {
        tags: ['📱 Paiements Mobile'], summary: 'Initier un paiement Airtel Money / Moov Money',
        requestBody: { required: true, content: { 'application/json': { schema: { type: 'object', required: ['montant','telephone','operateur'], properties: {
          montant:    { type: 'number', example: 15000 },
          telephone:  { type: 'string', example: '077123456' },
          operateur:  { type: 'string', enum: ['airtel','moov'] },
          patientId:  { type: 'string' },
          honoraireId:{ type: 'string', nullable: true },
          description:{ type: 'string' },
        }}}}},
        responses: { 200: { description: 'Paiement initié (en attente confirmation)', content: { 'application/json': { schema: { type: 'object', properties: {
          id:         { type: 'string' },
          statut:     { type: 'string', enum: ['en_attente','confirme','echoue'] },
          reference:  { type: 'string' },
        }}}}}},
      },
    },
    '/api/paiements-mobile/{id}': {
      get: { tags:['📱 Paiements Mobile'], summary:'Statut d\'un paiement mobile', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Statut du paiement'}}},
    },

    // ══════════════════════════════════════════════
    // INTELLIGENCE IA
    // ══════════════════════════════════════════════
    '/api/analytics/epidemio': {
      get: {
        tags: ['🤖 Intelligence IA'], summary: 'Analyse épidémiologique (patients du médecin)',
        responses: { 200: { description: 'Tendances diagnostics, âge moyen, répartition sexe, pathologies chroniques' }},
      },
    },
    '/api/analytics/risk': {
      get: {
        tags: ['🤖 Intelligence IA'], summary: 'Scores de risque patients (HTA, diabète, paludisme…)',
        responses: { 200: { description: 'Patients à risque classés par score' }},
      },
    },
    '/api/analytics/forecast': {
      get: {
        tags: ['🤖 Intelligence IA'], summary: 'Prévisions d\'activité (7 jours)',
        responses: { 200: { description: 'Prévision consultations, honoraires, charge de travail' }},
      },
    },
    '/api/analytics/medico-eco': {
      get: {
        tags: ['🤖 Intelligence IA'], summary: 'Analyse médico-économique',
        responses: { 200: { description: 'ROI par acte, coût moyen par diagnostic, optimisation facturation' }},
      },
    },
    '/api/intelligence/perdus-de-vue': {
      get: {
        tags: ['🤖 Intelligence IA'], summary: 'Patients perdus de vue',
        parameters: [{ name: 'mois', in: 'query', schema: { type: 'integer', default: 3 }, description: 'Inactivité depuis X mois' }],
        responses: { 200: { description: 'Patients sans consultation depuis N mois' }},
      },
    },
    '/api/intelligence/rappel/{patientId}': {
      post: {
        tags: ['🤖 Intelligence IA'], summary: 'Envoyer un rappel de suivi (SMS / email)',
        parameters: [{ name: 'patientId', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Rappel envoyé' }},
      },
    },

    // ══════════════════════════════════════════════
    // ANALYTICS
    // ══════════════════════════════════════════════
    '/api/analytics': {
      get: {
        tags: ['📉 Analytics'], summary: 'Analytiques consultations (période)',
        parameters: [
          { name: 'from', in: 'query', required: true, schema: { type: 'string', format: 'date' }},
          { name: 'to',   in: 'query', required: true, schema: { type: 'string', format: 'date' }},
        ],
        responses: { 200: { description: 'Consultations, taux validation, top motifs, assurances, démographie' }},
      },
    },
    '/api/search': {
      get: {
        tags: ['📉 Analytics'], summary: 'Recherche globale (patients + consultations)',
        parameters: [{ name: 'q', in: 'query', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Résultats combinés patients et consultations' }},
      },
    },

    // ══════════════════════════════════════════════
    // FHIR R4
    // ══════════════════════════════════════════════
    '/fhir/metadata': {
      get: {
        tags: ['🔬 FHIR R4'], summary: 'CapabilityStatement FHIR R4',
        security: [],
        responses: { 200: { description: 'Déclaration des capacités FHIR de l\'API' }},
      },
    },
    '/fhir/Patient': {
      get: {
        tags: ['🔬 FHIR R4'], summary: 'Patients au format FHIR R4 Bundle',
        parameters: [{ name: 'name', in: 'query', schema: { type: 'string' }}, { name: 'identifier', in: 'query', schema: { type: 'string' }}],
        responses: { 200: { description: 'Bundle FHIR Patient' }},
      },
    },
    '/fhir/Patient/{id}': {
      get: {
        tags: ['🔬 FHIR R4'], summary: 'Patient FHIR par ID',
        parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'string' }}],
        responses: { 200: { description: 'Resource FHIR Patient' }, 404: { description: 'Introuvable' }},
      },
    },
    '/fhir/Encounter': {
      get: {
        tags: ['🔬 FHIR R4'], summary: 'Consultations au format FHIR Encounter',
        parameters: [{ name: 'patient', in: 'query', schema: { type: 'string' }, description: 'ID patient FHIR' }],
        responses: { 200: { description: 'Bundle Encounter' }},
      },
    },
    '/fhir/Observation': {
      get: {
        tags: ['🔬 FHIR R4'], summary: 'Constantes vitales au format FHIR Observation',
        parameters: [{ name: 'patient', in: 'query', schema: { type: 'string' }}],
        responses: { 200: { description: 'Bundle Observation (TA, FC, température, SpO2…)' }},
      },
    },

    // ══════════════════════════════════════════════
    // ALERTES
    // ══════════════════════════════════════════════
    '/api/alerts': {
      get:  { tags:['🔔 Alertes'], summary:'Alertes non lues du médecin', responses:{200:{description:'Liste des alertes avec type et sévérité'}}},
      post: { tags:['🔔 Alertes'], summary:'Créer une alerte', requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{type:{type:'string'},message:{type:'string'},severite:{type:'string',enum:['info','warning','danger']}}}}}}, responses:{200:{description:'Alerte créée'}}},
    },
    '/api/alerts/{id}/read': {
      patch: { tags:['🔔 Alertes'], summary:'Marquer une alerte comme lue', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Lue'}}},
    },
    '/api/alerts/read-all': {
      post: { tags:['🔔 Alertes'], summary:'Marquer toutes les alertes comme lues', responses:{200:{description:'OK'}}},
    },

    // ══════════════════════════════════════════════
    // PAPETERIE
    // ══════════════════════════════════════════════
    '/api/patients/{id}/papeterie/arret-maladie/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Générer un arrêt de travail PDF', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{dateDebut:{type:'string'},dateFin:{type:'string'},diagnostic:{type:'string'},reprise:{type:'string'}}}}}} , responses:{200:{description:'PDF arrêt maladie',content:{'application/pdf':{}}}}},
    },
    '/api/patients/{id}/papeterie/certificat-sante/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Certificat médical de santé', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{objet:{type:'string'},conclusion:{type:'string'}}}}}}, responses:{200:{description:'PDF certificat',content:{'application/pdf':{}}}}},
    },
    '/api/patients/{id}/papeterie/dispense-sport/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Dispense de sport', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{duree:{type:'string'},motif:{type:'string'}}}}}}, responses:{200:{description:'PDF',content:{'application/pdf':{}}}}},
    },
    '/api/patients/{id}/papeterie/attestation-soins/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Attestation de soins', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}}, responses:{200:{description:'PDF',content:{'application/pdf':{}}}}},
    },
    '/api/consultations/{id}/arret-maladie/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Arrêt maladie depuis une consultation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{dateDebut:{type:'string'},dateFin:{type:'string'}}}}}}, responses:{200:{description:'PDF',content:{'application/pdf':{}}}}},
    },
    '/api/consultations/{id}/certificat/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Certificat médical depuis consultation', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{objet:{type:'string'}}}}}}, responses:{200:{description:'PDF',content:{'application/pdf':{}}}}},
    },
    '/api/consultations/{id}/adressage/pdf': {
      post: { tags:['📄 Papeterie'], summary:'Lettre d\'adressage / courrier spécialiste', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{destinataire:{type:'string'},motif:{type:'string'}}}}}}, responses:{200:{description:'PDF courrier',content:{'application/pdf':{}}}}},
    },

    // ══════════════════════════════════════════════
    // AUDIT
    // ══════════════════════════════════════════════
    '/api/audit': {
      get: {
        tags: ['🔎 Audit'], summary: 'Journal d\'audit des actions sensibles',
        parameters: [
          { name: 'from',   in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'to',     in: 'query', schema: { type: 'string', format: 'date' }},
          { name: 'action', in: 'query', schema: { type: 'string' }, description: 'Filtrer par action (LOGIN, UPDATE_PATIENT, CREATE_CONSULTATION…)' },
          { name: 'limit',  in: 'query', schema: { type: 'integer', default: 100 }},
        ],
        responses: { 200: { description: 'Entrées audit : userId, action, entityType, entityId, ip, timestamp' }},
      },
    },

    // ══════════════════════════════════════════════
    // ADMINISTRATION
    // ══════════════════════════════════════════════
    '/api/admin/backup': {
      post: {
        tags: ['⚙️ Administration'], summary: 'Déclencher un backup manuel vers S3',
        description: 'Compresse `data.db` (gzip) et l\'envoie sur le bucket S3 configuré. Nécessite les variables AWS.',
        responses: {
          200: { description: 'Backup réussi ou ignoré (si AWS non configuré)', content: { 'application/json': { schema: { type: 'object', properties: {
            message: { type: 'string' },
            key:     { type: 'string', nullable: true, description: 'Clé S3 du fichier' },
            size:    { type: 'integer', nullable: true, description: 'Taille compressée (octets)' },
          }}}}},
        },
      },
    },
    '/api/users': {
      get: { tags:['⚙️ Administration'], summary:'Liste des médecins (pour invite discussion)', responses:{200:{description:'Médecins du site'}}},
    },
    '/api/sites': {
      get:  { tags:['⚙️ Administration'], summary:'Liste des sites médicaux', responses:{200:{description:'Sites'}}},
      post: { tags:['⚙️ Administration'], summary:'Créer un site', requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{nom:{type:'string'},adresse:{type:'string'}}}}}}, responses:{200:{description:'Site créé'}}},
    },
    '/api/profile/disponibilites': {
      get: { tags:['⚙️ Administration'], summary:'Disponibilités du médecin (planning)', responses:{200:{description:'Créneaux configurés'}}},
      put: { tags:['⚙️ Administration'], summary:'Mettre à jour les disponibilités', requestBody:{required:true,content:{'application/json':{schema:{type:'object'}}}}, responses:{200:{description:'Mis à jour'}}},
    },

    // Circulation
    '/api/flow/today': {
      get: { tags:['📉 Analytics'], summary:'File d\'attente du jour (flux patients)', responses:{200:{description:'Patients en salle, en consultation, terminés'}}},
    },
    '/api/appointments/{id}/flow': {
      put: { tags:['📅 Agenda'], summary:'Mettre à jour le statut de flux (arrivé, en attente, en salle)', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], requestBody:{required:true,content:{'application/json':{schema:{type:'object',properties:{statut:{type:'string',enum:['attend','en_salle','termine']}}}}}}, responses:{200:{description:'Flux mis à jour'}}},
    },
    '/api/appointments/{id}/reminder': {
      post: { tags:['📅 Agenda'], summary:'Envoyer un rappel RDV (SMS)', parameters:[{name:'id',in:'path',required:true,schema:{type:'string'}}], responses:{200:{description:'Rappel envoyé'}}},
    },
  },
};
