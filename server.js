const express = require('express');
const cors = require('cors');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { exec } = require('child_process');

const app = express();
const porta = 3000;

// ==============================================================
// ⚙️ CONFIGURAÇÃO DE AMBIENTE E BANCO DE DADOS
// ==============================================================
const MODO_TESTE = true; 

/*const db = new sqlite3.Database('./inventario.db');*/
const db = new sqlite3.Database('C:\\Users\\ifdesilva\\Documents\\ebalmaq-github\\inventario_github.db');

// Ativa as chaves estrangeiras no SQLite para manter a integridade
db.run("PRAGMA foreign_keys = ON;");

// 🚀 INICIALIZAÇÃO AUTOMÁTICA: Cria as tabelas se o banco SQLite estiver zerado
db.serialize(() => {
    db.run(`CREATE TABLE IF NOT EXISTS estacoes (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        andar TEXT,
        setor TEXT,
        sala TEXT,
        observacao TEXT
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS equipamentos (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estacao_id INTEGER,
        posicao TEXT,
        modelo TEXT,
        patrimonio TEXT,
        status TEXT DEFAULT 'ativo'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS historico (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        estacao_id INTEGER,
        data_acao TEXT,
        acao TEXT
    )`);
});
app.use(cors());
app.use(express.json());

const authCache = new Map();
const pendingAuth = new Map(); 

// Tempo de expiração do Token (12 horas)
const TOKEN_EXPIRATION_MS = 12 * 60 * 60 * 1000; 

// ==============================================================
// 🧹 LIMPEZA DE MEMÓRIA (ANTI MEMORY-LEAK)
// ==============================================================
setInterval(() => {
    const agora = Date.now();
    for (const [token, dados] of authCache.entries()) {
        if (agora > dados.expiresAt) {
            authCache.delete(token);
        }
    }
}, 60 * 60 * 1000); // Roda a cada 1 hora

// ==============================================================
// 🛡️ VALIDAÇÕES GLOBAIS DE ENTRADA
// ==============================================================
const normalizarPatrimonio = (texto) => {
    if (!texto) return '0';
    let t = texto.toString().trim();
    if (t === '' || /^0+$/.test(t)) return '0';
    return t;
};

// Trava contra sobrecarga do banco de dados (Textos gigantes)
const excedeTamanho = (texto, max) => {
    if (texto && texto.toString().length > max) return true;
    return false;
};

// ==============================================================
// 📝 SISTEMA DE LOGS EM ARQUIVO DE TEXTO (AUDITORIA)
// ==============================================================
function registrarLogAuditoria(acao, usuario, req) {
    const data = new Date().toLocaleString('pt-BR');
    let ip = req ? (req.headers['x-forwarded-for'] || req.socket.remoteAddress) : 'Sistema';
    if (ip === '::1' || ip === '::ffff:127.0.0.1') ip = 'localhost';

    const linhaLog = `[${data}] [IP: ${ip}] [Usuário: ${usuario}] ${acao}\n`;
    
    fs.appendFile('acessos_ebalmaq.txt', linhaLog, (err) => {
        if (err) console.error('Falha ao escrever no arquivo de log:', err);
    });
    console.log(linhaLog.trim());
}

// ==============================================================
// 🚦 FILAS DE PROCESSAMENTO (CONCORRÊNCIA E RACE CONDITIONS)
// ==============================================================

let isAuthenticating = false;
const authQueue = [];

function processAuthQueue() {
    if (isAuthenticating || authQueue.length === 0) return;
    isAuthenticating = true;
    
    const { command, env, resolve, reject } = authQueue.shift();
    
    exec(command, { env, timeout: 15000 }, (err, stdout) => {
        if (stdout && stdout.startsWith("OK|")) {
            resolve(stdout.split('|')[1].trim());
        } else {
            reject(new Error("Falha no AD ou Tempo Excedido"));
        }
        isAuthenticating = false;
        processAuthQueue(); 
    });
}

const dbQueue = {
    promise: Promise.resolve(),
    enqueue(task) {
        return new Promise((resolve, reject) => {
            this.promise = this.promise.then(async () => {
                try { resolve(await task()); } catch(e) { reject(e); }
            });
        });
    }
};

const getDb = (sql, params) => new Promise((resolve, reject) => db.get(sql, params, (err, row) => err ? reject(err) : resolve(row)));
const allDb = (sql, params) => new Promise((resolve, reject) => db.all(sql, params, (err, rows) => err ? reject(err) : resolve(rows)));
const runDb = (sql, params) => new Promise((resolve, reject) => db.run(sql, params, function(err) { err ? reject(err) : resolve(this) }));

async function verificarPatrimonioEmUso(patrimonio) {
    if (!patrimonio || patrimonio === '0' || patrimonio.startsWith('0_temp')) return false;
    const row = await getDb("SELECT id FROM equipamentos WHERE patrimonio = ? AND status = 'ativo'", [patrimonio]);
    return !!row;
}

// ==============================================================
// 🚪 ROTA DE LOGIN
// ==============================================================
app.post('/api/login', async (req, res) => {
    let { usuario, senha } = req.body;

    if (!usuario || !senha) return res.status(400).json({ erro: 'Usuário e senha são obrigatórios' });

    if (usuario.includes('\\')) usuario = usuario.split('\\')[1];
    if (usuario.includes('@')) usuario = usuario.split('@')[0];

    if (MODO_TESTE) {
        const nomeBonitinho = usuario.charAt(0).toUpperCase() + usuario.slice(1).toLowerCase();
        const nomeExibicao = `${nomeBonitinho} (Teste)`; 
        
        const token = crypto.randomBytes(32).toString('hex');
        authCache.set(token, { usuario: usuario, nomeDisplay: nomeExibicao, expiresAt: Date.now() + TOKEN_EXPIRATION_MS });
        
        registrarLogAuditoria("LOGIN BEM-SUCEDIDO (Modo Teste)", usuario, req);
        return res.json({ sucesso: true, token, nome: nomeExibicao });
    }

    const psCommand = "Add-Type -AssemblyName System.DirectoryServices.AccountManagement; try { $pc = New-Object System.DirectoryServices.AccountManagement.PrincipalContext([System.DirectoryServices.AccountManagement.ContextType]::Domain); if ($pc.ValidateCredentials($env:AD_USER, $env:AD_PASS)) { $user = [System.DirectoryServices.AccountManagement.UserPrincipal]::FindByIdentity($pc, $env:AD_USER); if ($user.DisplayName) { Write-Output ('OK|' + $user.DisplayName) } else { Write-Output ('OK|' + $env:AD_USER) } } else { Write-Output 'FAIL' } } catch { Write-Output 'ERROR' }";

    const authKey = `${usuario}:${senha}`;
    if (pendingAuth.has(authKey)) {
        return res.status(429).json({ erro: 'Autenticação já em andamento. Aguarde.' });
    }

    const authPromise = new Promise((resolve, reject) => {
        authQueue.push({ command: `powershell -NoProfile -Command "${psCommand}"`, env: { ...process.env, AD_USER: usuario, AD_PASS: senha }, resolve, reject });
        processAuthQueue();
    });

    pendingAuth.set(authKey, authPromise);

    try {
        const nomeCompletoAD = await authPromise;
        const token = crypto.randomBytes(32).toString('hex');
        
        authCache.set(token, { usuario: usuario, nomeDisplay: nomeCompletoAD, expiresAt: Date.now() + TOKEN_EXPIRATION_MS });
        pendingAuth.delete(authKey);
        
        registrarLogAuditoria("LOGIN BEM-SUCEDIDO", usuario, req);
        return res.json({ sucesso: true, token, nome: nomeCompletoAD });
    } catch (error) {
        pendingAuth.delete(authKey);
        registrarLogAuditoria("TENTATIVA DE ACESSO NEGADA", usuario, req);
        return res.status(401).json({ erro: 'Credenciais inválidas ou falha de rede.' });
    }
});

const verificarToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ erro: 'Acesso negado. Token não fornecido.' });
    }

    const token = authHeader.split(' ')[1];
    const sessao = authCache.get(token);

    if (!sessao || Date.now() > sessao.expiresAt) {
        if (sessao) authCache.delete(token); 
        return res.status(401).json({ erro: 'Sessão expirada ou inválida.' });
    }

    req.usuarioRede = sessao.usuario;
    req.nomeRede = sessao.nomeDisplay;
    req.tokenAtivo = token;
    
    sessao.expiresAt = Date.now() + TOKEN_EXPIRATION_MS; 
    next();
};

app.post('/api/logout', verificarToken, (req, res) => {
    authCache.delete(req.tokenAtivo);
    registrarLogAuditoria("SESSÃO ENCERRADA (Logout)", req.nomeRede, req);
    res.json({ sucesso: true });
});

app.use(express.static(__dirname));

//ROTAS DE ACESSO PARA CADA ARQUIVO ESPECÍFICO
app.get('/', (req, res) => {
    //res.sendFile(path.join(__dirname, 'index.html'));
    //res.sendFile(path.join(__dirname, 'index - pcs e notebooks.html'));
    res.sendFile(path.join(__dirname, 'index - completo.html'));
});

// ==============================================================
// 📦 ROTAS DE ESTOQUE E DEFEITOS
// ==============================================================

// Rota do estoque
app.get('/api/estoque', async (req, res) => {
    try {
        const itensEstoque = await allDb("SELECT posicao AS tipo, modelo, COUNT(*) as qtd FROM equipamentos WHERE status = 'estoque' GROUP BY modelo, posicao", []);
        res.json(itensEstoque);
    } catch (error) {
        console.error(error);
        res.status(500).json({ erro: "Erro ao buscar estoque." });
    }
});

// 🚀 NOVA ROTA: Busca equipamentos que foram baixados por Defeito
app.get('/api/defeitos', async (req, res) => {
    try {
        // Mostrar o patrimônio exato da máquina com defeito
        const itensDefeito = await allDb("SELECT posicao AS tipo, modelo, patrimonio FROM equipamentos WHERE status = 'defeito' ORDER BY modelo ASC", []);
        res.json(itensDefeito);
    } catch (error) {
        console.error(error);
        res.status(500).json({ erro: "Erro ao buscar itens com defeito." });
    }
});

// TODAS AS ROTAS DAQUI PARA BAIXO EXIGEM LOGIN
app.use('/api', verificarToken);

app.get('/api/me', (req, res) => {
    res.json({ usuario: req.usuarioRede, nome: req.nomeRede });
});

app.get('/api/inventario', async (req, res) => {
    try {
        const estacoes = await allDb("SELECT * FROM estacoes", []);
        const equipamentos = await allDb("SELECT * FROM equipamentos WHERE status = 'ativo' AND estacao_id IS NOT NULL", []);
        const historicos = await allDb("SELECT * FROM historico ORDER BY id DESC", []);

        const inventarioFormatado = estacoes.map(est => {
            const equipsDaMesa = equipamentos.filter(e => e.estacao_id === est.id);
            const historicoDaMesa = historicos.filter(h => h.estacao_id === est.id);
            return {
                id: est.id, andar: est.andar, setor: est.setor, sala: est.sala, observacao: est.observacao,
                historico: historicoDaMesa, todos_equipamentos: equipsDaMesa 
            };
        });
        res.json(inventarioFormatado);
    } catch (error) {
        console.error("[Erro BD Inventário]:", error.message);
        res.status(500).json({ erro: "Erro interno no processamento do banco de dados." });
    }
});

app.put('/api/atualizar', (req, res) => {
    dbQueue.enqueue(async () => {
        try {
            const { id_estacao, posicao, patrimonio, acao } = req.body;
            const usuarioLogado = req.nomeRede; 
            
            if (excedeTamanho(acao, 200)) return res.status(400).json({ erro: "Descrição da ação excede o limite." });
            
            const patFinal = normalizarPatrimonio(patrimonio);
            if (excedeTamanho(patFinal, 50)) return res.status(400).json({ erro: "Patrimônio excede o tamanho permitido." });

            if (await verificarPatrimonioEmUso(patFinal)) {
                registrarLogAuditoria(`TENTATIVA DE PATRIMÔNIO DUPLICADO (PAT: ${patFinal})`, req.usuarioRede, req);
                return res.status(400).json({ erro: "Patrimônio já cadastrado em outro equipamento!" });
            }

            const sqlUpdate = `UPDATE equipamentos SET patrimonio = ? WHERE estacao_id = ? AND posicao = ? AND status = 'ativo'`;
            await runDb(sqlUpdate, [patFinal, id_estacao, posicao]);

            const acaoFinal = `[${usuarioLogado}] ${acao}`;
            const dataFinal = new Date().toLocaleString('pt-BR');
            await runDb(`INSERT INTO historico (estacao_id, data_acao, acao) VALUES (?, ?, ?)`, [id_estacao, dataFinal, acaoFinal]);
            
            registrarLogAuditoria(`ATUALIZOU DADOS: ${acao}`, req.usuarioRede, req);
            res.json({ sucesso: true });

        } catch (error) {
            console.error("[Erro BD Atualizar]:", error.message);
            res.status(500).json({ erro: "Erro interno no processamento do banco de dados." });
        }
    });
});

app.post('/api/adicionar-equipamento', (req, res) => {
    dbQueue.enqueue(async () => {
        try {
            const { id_estacao, tipo, modelo, patrimonio, acao } = req.body;
            const usuarioLogado = req.nomeRede;
            
            if (excedeTamanho(modelo, 100)) return res.status(400).json({ erro: "O modelo excede o limite de caracteres." });
            if (excedeTamanho(acao, 200)) return res.status(400).json({ erro: "Descrição da ação excede o limite." });

            const patFinal = normalizarPatrimonio(patrimonio);
            if (excedeTamanho(patFinal, 50)) return res.status(400).json({ erro: "Patrimônio excede o tamanho permitido." });

            if (await verificarPatrimonioEmUso(patFinal)) {
                registrarLogAuditoria(`TENTATIVA DE PATRIMÔNIO DUPLICADO (PAT: ${patFinal})`, req.usuarioRede, req);
                return res.status(400).json({ erro: "Patrimônio já cadastrado no sistema!" });
            }

            const rows = await allDb("SELECT posicao FROM equipamentos WHERE estacao_id = ? AND posicao LIKE ? AND status = 'ativo'", [id_estacao, `${tipo}%`]);

            let novaPosicao = tipo;
            if (tipo === 'mon') novaPosicao = 'mon1'; 

            if (rows && rows.length > 0) {
                let count = rows.length + 1;
                novaPosicao = `${tipo === 'mon' ? 'mon' : tipo}_${count}`;
                while(rows.find(r => r.posicao === novaPosicao)) {
                    count++;
                    novaPosicao = `${tipo === 'mon' ? 'mon' : tipo}_${count}`;
                }
            }

            const itemEstoque = await getDb("SELECT id FROM equipamentos WHERE LOWER(TRIM(modelo)) = LOWER(TRIM(?)) AND status = 'estoque' LIMIT 1", [modelo]);

            if (itemEstoque) {
                await runDb(`UPDATE equipamentos SET estacao_id = ?, posicao = ?, patrimonio = ?, status = 'ativo' WHERE id = ?`, [id_estacao, novaPosicao, patFinal, itemEstoque.id]);
            } else {
                await runDb(`INSERT INTO equipamentos (estacao_id, posicao, modelo, patrimonio, status) VALUES (?, ?, ?, ?, 'ativo')`, [id_estacao, novaPosicao, modelo, patFinal]);
            }

            let nomeAmigavel = tipo.toUpperCase();
            if (tipo === 'pc') nomeAmigavel = 'Computador';
            if (tipo === 'mon') nomeAmigavel = 'Monitor';
            if (tipo === 'notebook') nomeAmigavel = 'Notebook';

            const patMsg = (patFinal !== '0') ? `(PAT: ${patFinal})` : `(SEM PATRIMÔNIO)`;
            const acaoFinal = `[${usuarioLogado}] ${acao || `Adicionou ${nomeAmigavel} (${modelo})`}`;
            const dataFinal = new Date().toLocaleString('pt-BR');

            await runDb(`INSERT INTO historico (estacao_id, data_acao, acao) VALUES (?, ?, ?)`, [id_estacao, dataFinal, acaoFinal]);
            
            registrarLogAuditoria(`ADICIONOU ITEM: ${nomeAmigavel} '${modelo}' ${patMsg} na estação ID ${id_estacao}`, req.usuarioRede, req);
            res.json({ sucesso: true });

        } catch (error) {
            console.error("[Erro BD Add Equipamento]:", error.message);
            res.status(500).json({ erro: "Erro interno no processamento do banco de dados." });
        }
    });
});

// 🚀 ROTA DE REMOÇÃO ATUALIZADA (Agora gerencia as substituições e destino correto)
app.post('/api/remover-equipamento', (req, res) => {
    dbQueue.enqueue(async () => {
        try {
            const { id_estacao, posicao, modelo, patrimonio, motivo, obs_motivo, tipo, modelo_substituto } = req.body;
            const usuarioLogado = req.nomeRede;

            let novoStatus = 'inativo';
            let descMotivo = motivo;

            // Define para onde vai a máquina antiga
            if (motivo === 'defeito' || motivo === 'substituicao_defeito') {
                novoStatus = 'defeito'; 
                descMotivo = 'Apresentou Defeito';
            } else if (motivo === 'estoque' || motivo === 'substituicao_estoque') {
                novoStatus = 'estoque'; 
                descMotivo = 'Devolvido ao Estoque';
            } else if (motivo === 'outro') {
                novoStatus = 'estoque'; 
                descMotivo = obs_motivo || 'Sem detalhes';
            }

            // 1. Remove a máquina velha
            await runDb(`UPDATE equipamentos SET status = ?, estacao_id = NULL WHERE estacao_id = ? AND posicao = ? AND status = 'ativo'`, [novoStatus, id_estacao, posicao]);

            // 2. Se for substituição, aloca a máquina nova
            let acaoFinal = `[${usuarioLogado}] Removeu ${tipo} (${modelo}) da estação. Destino: ${novoStatus.toUpperCase()}. Motivo: ${descMotivo}`;

            if (modelo_substituto) {
                // Puxa a nova máquina do estoque
                const itemEstoque = await getDb("SELECT id, patrimonio FROM equipamentos WHERE LOWER(TRIM(modelo)) = LOWER(TRIM(?)) AND status = 'estoque' LIMIT 1", [modelo_substituto]);
                if (itemEstoque) {
                    await runDb(`UPDATE equipamentos SET estacao_id = ?, posicao = ?, status = 'ativo' WHERE id = ?`, [id_estacao, posicao, itemEstoque.id]);
                    acaoFinal = `[${usuarioLogado}] Substituiu ${tipo} (${modelo}) por ${modelo_substituto} (PAT: ${itemEstoque.patrimonio || 'S/N'}). Antigo foi para: ${novoStatus.toUpperCase()}`;
                } else {
                    acaoFinal += ` (Aviso: O substituto ${modelo_substituto} não foi encontrado no estoque)`;
                }
            }

            const dataFinal = new Date().toLocaleString('pt-BR');
            await runDb(`INSERT INTO historico (estacao_id, data_acao, acao) VALUES (?, ?, ?)`, [id_estacao, dataFinal, acaoFinal]);

            // 3. Exclui a estação se ela ficou completamente vazia
            const ativosRestantes = await getDb("SELECT COUNT(*) as qtd FROM equipamentos WHERE estacao_id = ? AND status = 'ativo'", [id_estacao]);
            if (ativosRestantes.qtd === 0) { 
                await runDb("DELETE FROM historico WHERE estacao_id = ?", [id_estacao]);
                await runDb("DELETE FROM estacoes WHERE id = ?", [id_estacao]); 
            }

            registrarLogAuditoria(acaoFinal, req.usuarioRede, req);
            res.json({ sucesso: true });

        } catch (error) {
            console.error("[Erro BD Remove Equipamento]:", error.message);
            res.status(500).json({ erro: "Erro interno no processamento do banco de dados." });
        }
    });
});

app.post('/api/adicionar-inventario-completo', (req, res) => {
    dbQueue.enqueue(async () => {
        try {
            const { andar, setor, sala, observacao, equipamentos } = req.body;
            const usuarioLogado = req.nomeRede;

            if (!andar || !setor || !sala) {
                registrarLogAuditoria("TENTATIVA FALHA DE CADASTRO (Dados incompletos)", req.usuarioRede, req);
                return res.status(400).json({ erro: "Localização incompleta." });
            }

            if (excedeTamanho(andar, 50) || excedeTamanho(setor, 50) || excedeTamanho(sala, 50)) {
                return res.status(400).json({ erro: "Nome de Andar, Setor ou Sala muito grande." });
            }
            if (excedeTamanho(observacao, 250)) {
                return res.status(400).json({ erro: "A observação não pode ter mais de 250 caracteres." });
            }

            if (equipamentos && equipamentos.length > 0) {
                for (const eq of equipamentos) {
                    if (!eq.modelo || eq.modelo.trim() === '') continue;
                    if (excedeTamanho(eq.modelo, 100)) return res.status(400).json({ erro: `Modelo '${eq.modelo}' muito longo.` });
                    
                    let pat = normalizarPatrimonio(eq.patrimonio);
                    if (excedeTamanho(pat, 50)) return res.status(400).json({ erro: `Patrimônio '${pat}' muito longo.` });

                    if (await verificarPatrimonioEmUso(pat)) {
                        registrarLogAuditoria(`TENTATIVA DE PATRIMÔNIO DUPLICADO NO LOTE (PAT: ${pat})`, req.usuarioRede, req);
                        return res.status(400).json({ erro: `O patrimônio ${pat} já está em uso.` });
                    }
                }
            }

            const dataFinal = new Date().toLocaleString('pt-BR');

            const insertEst = await runDb(`INSERT INTO estacoes (andar, setor, sala, observacao) VALUES (?, ?, ?, ?)`, [andar, setor, sala, observacao || '']);
            const estacao_id = insertEst.lastID;
            
            await runDb(`INSERT INTO historico (estacao_id, data_acao, acao) VALUES (?, ?, ?)`, [estacao_id, dataFinal, `[${usuarioLogado}] Cadastrou nova estação na localidade (${setor} - ${sala})`]);
            registrarLogAuditoria(`CRIOU NOVA ESTAÇÃO: Localidade ${andar} / ${setor} - ${sala}`, req.usuarioRede, req);

            if (!equipamentos || equipamentos.length === 0) return res.json({ sucesso: true, id: estacao_id });

            let contadores = { pc: 0, notebook: 0, mon: 0, impressora: 0, camera: 0, tv: 0 };

            for (const eq of equipamentos) {
                if (!eq.modelo || eq.modelo.trim() === '') continue;

                let pat = normalizarPatrimonio(eq.patrimonio);
                contadores[eq.tipo] = (contadores[eq.tipo] || 0) + 1;
                
                let posicao = eq.tipo;
                if (eq.tipo === 'mon') { posicao = `mon${contadores[eq.tipo]}`; } 
                else if (contadores[eq.tipo] > 1) { posicao = `${eq.tipo}_${contadores[eq.tipo]}`; }

                const itemEstoque = await getDb("SELECT id FROM equipamentos WHERE LOWER(TRIM(modelo)) = LOWER(TRIM(?)) AND status = 'estoque' LIMIT 1", [eq.modelo]);

                if (itemEstoque) {
                    await runDb(`UPDATE equipamentos SET estacao_id = ?, posicao = ?, patrimonio = ?, status = 'ativo' WHERE id = ?`, [estacao_id, posicao, pat, itemEstoque.id]);
                } else {
                    await runDb(`INSERT INTO equipamentos (estacao_id, posicao, modelo, patrimonio, status) VALUES (?, ?, ?, ?, 'ativo')`, [estacao_id, posicao, eq.modelo.trim(), pat]);
                }

                let nomeAmigavel = eq.tipo.charAt(0).toUpperCase() + eq.tipo.slice(1);
                if (eq.tipo === 'pc') nomeAmigavel = 'Computador';
                if (eq.tipo === 'mon') nomeAmigavel = 'Monitor';

                const patMsg = pat !== '0' ? `(PAT: ${pat})` : `(SEM PATRIMÔNIO)`;
                await runDb(`INSERT INTO historico (estacao_id, data_acao, acao) VALUES (?, ?, ?)`, [estacao_id, dataFinal, `[${usuarioLogado}] Adicionou ${nomeAmigavel} (${eq.modelo}) à estação`]);
            }

            res.json({ sucesso: true, id: estacao_id });

        } catch (error) {
            console.error("[Erro BD Add Lote]:", error.message);
            registrarLogAuditoria(`ERRO AO GRAVAR INVENTÁRIO: ${error.message}`, req.usuarioRede, req);
            res.status(500).json({ erro: "Erro interno no processamento do banco de dados." });
        }
    });
});

app.listen(porta, '0.0.0.0', () => {
    console.log(`📡 Servidor liberado para rede local na porta ${porta}! Acesse via http://10.182.104.1:${porta}`);
    console.log(`🚀 Servidor Ebalmaq AUTENTICAÇÃO VIA TOKEN! (Com Banco Blindado e Anticolisão)`);
    console.log(`🔧 MODO_TESTE está configurado como: ${MODO_TESTE ? 'ATIVADO' : 'DESATIVADO'}`);
});