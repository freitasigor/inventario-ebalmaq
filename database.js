const sqlite3 = require('sqlite3').verbose();
const fs = require('fs');

const dbFile = './inventario_github.db';

const db = new sqlite3.Database(dbFile);

console.log('Iniciando a criação das tabelas (Sem trava de duplicados)...');

db.serialize(() => {
    // 1. Tabela de Estações
    db.run(`CREATE TABLE IF NOT EXISTS estacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        andar TEXT,
        setor TEXT,
        sala TEXT,
        observacao TEXT
    )`);

    // 2. Tabela de Equipamentos (Com a nova coluna STATUS e ON DELETE CASCADE)
    db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estacao_id INTEGER,
        posicao TEXT,
        modelo TEXT,
        patrimonio TEXT,
        status TEXT DEFAULT 'ativo',
        FOREIGN KEY (estacao_id) REFERENCES estacoes(id) ON DELETE CASCADE
    )`);

    // 3. Tabela de Histórico (Com ON DELETE CASCADE)
    db.run(`CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estacao_id INTEGER,
        data_acao TEXT,
        acao TEXT,
        FOREIGN KEY (estacao_id) REFERENCES estacoes(id) ON DELETE CASCADE
    )`);

    // 4. TRAVA REMOVIDA E BANCO LIBERADO
    // A blindagem 'UNIQUE' foi totalmente apagada daqui. 
    // Agora o SQLite vai engolir patrimônios idênticos e salvar todos eles, 
    // sem cuspir fora e sem forçar a virar "Pendente".

    console.log("✅ Estrutura do Banco de Dados criada com sucesso!");
    console.log("🔓 Banco de dados LIVRE: Agora ele aceita patrimônios repetidos nativamente.");
});

db.close();