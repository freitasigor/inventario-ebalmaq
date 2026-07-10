const fs = require('fs');
const csv = require('csv-parser');
const sqlite3 = require('sqlite3').verbose();
const path = require('path');

// 🚀 CORREÇÃO 1: Garante que a importação morda o MESMO banco de dados que o server.js lê
const dbFile = path.join(__dirname, 'inventario_github.db');
const db = new sqlite3.Database(dbFile);

// 🚀 CORREÇÃO 2: Garante que o Node ache o CSV mesmo se você rodar o comando de pastas diferentes
const nomeCSV = 'inventario_github.csv';
const arquivoCSV = path.join(__dirname, nomeCSV);
const arquivoCSVEstoque = path.join(__dirname, 'estoque_github.csv'); // <-- Mapeamento do arquivo de estoque

const arquivoLog = path.join(__dirname, 'patrimonios_duplicados.txt');

console.log('▶ Iniciando importação BRUTA (Tudo será salvo no banco em identidade absoluta)...\n');
console.log(`💾 Banco alvo: ${dbFile}`);
console.log(`📊 CSV origem ativos: ${arquivoCSV}`);
console.log(`📊 CSV origem estoque: ${arquivoCSVEstoque}\n`);

// 1. ARRANCANDO QUALQUER TRAVA RESIDUAL NO BANCO
db.run('DROP INDEX IF EXISTS idx_patrimonio_unico', (err) => {
    if(err) console.error("Aviso:", err.message);
});

fs.writeFileSync(arquivoLog, "=== RELATÓRIO DE PATRIMÔNIOS DUPLICADOS ===\n\n");
let encontrouErro = false;

function registrarDuplicadoTxt(andar, setor, sala, tipoNome, modelo, patrimonio) {
    encontrouErro = true;
    const data = new Date().toLocaleString('pt-BR');
    const linha = `[${data}] Andar: ${andar} | Setor: ${setor} | Sala: ${sala} | Equipamento: ${tipoNome} (${modelo}) | Plaqueta: ${patrimonio}\n`;
    fs.appendFileSync(arquivoLog, linha);
}

const traduzirNao = (texto) => {
    if (!texto) return '';
    const t = texto.trim().toUpperCase();
    if (t === 'NÃO POSSUI' || t === 'NAO POSSUI' || t === 'N/A' || t === 'NENHUM' || t === 'NÃO' || t === 'NAO') return 'NÃO';
    return texto.trim();
};

const normalizarPatrimonio = (texto) => {
    if (!texto) return '0';
    let t = texto.toString().trim();
    if (t === '' || /^0+$/.test(t)) return '0';
    return t;
};

const getNomeAmigavel = (posicao) => {
    if (posicao === 'pc') return 'Computador';
    if (posicao === 'notebook') return 'Notebook';
    if (posicao.startsWith('mon')) return 'Monitor';
    return posicao;
};

// 🛠️ Função de mapeamento exclusiva para o estoque
const mapearTipoEstoque = (tipoLido) => {
    const t = (tipoLido || '').toLowerCase();
    if (t.includes('computador') || t === 'pc') return 'pc';
    if (t.includes('monitor') || t.includes('tela')) return 'mon';
    if (t.includes('notebook')) return 'notebook';
    if (t.includes('impressora')) return 'impressora';
    if (t.includes('camera') || t.includes('câmera')) return 'camera';
    if (t.includes('tv') || t.includes('televisão')) return 'tv';
    return 'outros';
};

const memoriaGlobal = new Set();
const registrosParaInserir = [];

// 🛠️ Helpers do banco de dados (movidos para o escopo global)
const executarSQL = (query, params = []) => new Promise((resolve, reject) => {
    db.run(query, params, function(err) {
        if (err) reject(err);
        else resolve(this);
    });
});

const getDb = (sql, params = []) => new Promise((resolve, reject) => {
    db.get(sql, params, (err, row) => err ? reject(err) : resolve(row));
});

db.serialize(() => {
    // Puxa o que já tem no banco para o cruzamento de dados
    db.all("SELECT patrimonio FROM equipamentos WHERE status = 'ativo' AND patrimonio != '0'", [], (err, rows) => {
        if (rows) {
            rows.forEach(r => memoriaGlobal.add(r.patrimonio.toString().trim()));
        }

        fs.createReadStream(arquivoCSV, { encoding: 'latin1' })
            .pipe(csv({ separator: ';' }))
            .on('data', (row) => {
                
                // Limpeza dos cabeçalhos do Excel
                const r = {};
                Object.keys(row).forEach(k => {
                    const chaveLimpa = k.normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '').toLowerCase();
                    r[chaveLimpa] = row[k];
                });

                if (!r['andar'] && !r['setor']) return;

                const estacao = {
                    andar: r['andar'],
                    setor: r['setor'],
                    sala: r['sala'],
                    observacao: r['observacao'] || '',
                    equipamentos: []
                };

                const listaBruta = [
                    { posicao: 'pc', modelo: r['modelocomputador'], pat: r['patrimoniodocomputador'] },
                    { posicao: 'notebook', modelo: r['modelodonotebook'], pat: r['patrimonionotebook'] },
                    { posicao: 'mon1', modelo: r['modelomonitor1'], pat: r['patrimoniomonitor1'] },
                    { posicao: 'mon2', modelo: r['modelomonitor2'], pat: r['patrimoniomonitor2'] },
                    { posicao: 'mon3', modelo: r['modelomonitor3'], pat: r['patrimoniomonitor3'] }
                ];

                for (const item of listaBruta) {
                    const modelo = traduzirNao(item.modelo);
                    if (!modelo || modelo === 'NÃO') continue;

                    const pat = normalizarPatrimonio(item.pat);

                    // Valida a duplicidade na hora e salva no bloco de notas
                    if (pat !== '0') {
                        if (memoriaGlobal.has(pat)) {
                            const tipoNome = getNomeAmigavel(item.posicao);
                            registrarDuplicadoTxt(r['andar'], r['setor'], r['sala'], tipoNome, modelo, pat);
                        } else {
                            memoriaGlobal.add(pat); 
                        }
                    }

                    // Adiciona na fila
                    estacao.equipamentos.push({ posicao: item.posicao, modelo, pat });
                }

                registrosParaInserir.push(estacao);
            })
            .on('end', async () => {
                console.log(`Leitura do Excel de inventário concluída. Gravando ${registrosParaInserir.length} estações no banco uma a uma...`);

                try {
                    // Tranca a transação
                    await executarSQL('BEGIN TRANSACTION');

                    for (const est of registrosParaInserir) {
                        // Espera salvar a estação
                        const resEst = await executarSQL(`INSERT INTO estacoes (andar, setor, sala, observacao) VALUES (?, ?, ?, ?)`, [est.andar, est.setor, est.sala, est.observacao]);
                        const idEstacao = resEst.lastID;

                        for (const eq of est.equipamentos) {
                            try {
                                // Espera salvar o equipamento
                                await executarSQL(`INSERT INTO equipamentos (estacao_id, posicao, modelo, patrimonio) VALUES (?, ?, ?, ?)`, [idEstacao, eq.posicao, eq.modelo, eq.pat]);
                            } catch (errEq) {
                                console.error(`🚨 ERRO AO SALVAR ${eq.modelo} (${eq.pat}): ${errEq.message}`);
                            }
                        }
                    }

                    // Se chegou até aqui sem quebrar, ele commita (salva pra valer)
                    await executarSQL('COMMIT');

                    if (!encontrouErro) fs.appendFileSync(arquivoLog, "Nenhum patrimônio duplicado encontrado nesta importação.\n");
                    console.log('✅ Importação de Ativos concluída com SUCESSO!');
                    console.log(`Verifique o "patrimonios_duplicados.txt" para inconsistências.\n`);

                    // =========================================================================
                    // INÍCIO DA IMPORTAÇÃO DE ESTOQUE
                    // =========================================================================
                    
                    if (!fs.existsSync(arquivoCSVEstoque)) {
                        console.log('⚠️ Arquivo "estoque.csv" não encontrado na pasta. Finalizando script apenas com inventário.');
                        return;
                    }

                    console.log('▶ Iniciando leitura da planilha de Estoque (estoque.csv)...');
                    const itensEstoqueParaInserir = [];

                    fs.createReadStream(arquivoCSVEstoque, { encoding: 'latin1' })
                        .pipe(csv({ separator: ';' }))
                        .on('data', (rowEstoque) => {
                            const rE = {};
                            Object.keys(rowEstoque).forEach(k => {
                                const chaveLimpa = k.normalize('NFD').replace(/[\u0300-\u036f]/g, "").replace(/\s+/g, '').toLowerCase();
                                rE[chaveLimpa] = rowEstoque[k];
                            });

                            const modelo = rE['equipamento'] || rE['modelo'] || '';
                            const tipoBruto = rE['tipodeequipamento'] || rE['tipo'] || '';
                            const quantidade = parseInt(rE['quantidade']) || 0;
                            
                            if (modelo && quantidade > 0) {
                                const tipoFormatado = mapearTipoEstoque(tipoBruto);
                                
                                // O segredo da conversão: 16 de quantidade vira 16 INSERTs unitários no banco
                                for (let i = 0; i < quantidade; i++) {
                                    itensEstoqueParaInserir.push({
                                        posicao: tipoFormatado,
                                        modelo: modelo.trim(),
                                        patrimonio: '0', 
                                        status: 'estoque'
                                    });
                                }
                            }
                        })
                        .on('end', async () => {
                            console.log(`Leitura do Estoque concluída. Gravando ${itensEstoqueParaInserir.length} unidades individuais no banco...`);
                            
                            try {
                                await executarSQL('BEGIN TRANSACTION');

                                // 🚀 SOLUÇÃO PURA: Grava diretamente na tabela de equipamentos com estacao_id como NULL
                                for (const item of itensEstoqueParaInserir) {
                                    await executarSQL(`
                                        INSERT INTO equipamentos (estacao_id, posicao, modelo, patrimonio, status) 
                                        VALUES (NULL, ?, ?, ?, ?)
                                    `, [item.posicao, item.modelo, item.patrimonio, item.status]);
                                }

                                await executarSQL('COMMIT');
                                console.log('✅ ESTOQUE GRAVADO COMFORTAVELMENTE (Sem criação de salas falsas)!');
                                console.log('🚀 PROCESSO UNIFICADO FINALIZADO!');
                                
                            } catch (erroEstoque) {
                                await executarSQL('ROLLBACK');
                                console.error('❌ Erro fatal durante a gravação do Estoque:', erroEstoque.message);
                            }
                        });

                } catch (erroFatal) {
                    await executarSQL('ROLLBACK');
                    console.error('❌ Erro fatal durante a gravação principal:', erroFatal.message);
                }
            });
    });
});