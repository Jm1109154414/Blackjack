const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

// ── HTTP SERVER ──────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const routes = {
    '/':           'index.html',
    '/index.html': 'index.html',
    '/blackjack':  'blackjack.html',
    '/holdem':     'holdem.html',
  };
  const file = routes[req.url.split('?')[0]];
  if (!file) { res.writeHead(404); res.end('Not found'); return; }
  fs.readFile(path.join(__dirname, file), (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    const ct = file.endsWith('.html') ? 'text/html' : 'application/octet-stream';
    res.writeHead(200, { 'Content-Type': ct });
    res.end(data);
  });
});

// ── BLACKJACK WS SERVER ──────────────────────────────────────
const wss_bj = new WebSocket.Server({ noServer: true });

// ── HOLDEM WS SERVER ─────────────────────────────────────────
const wss_holdem = new WebSocket.Server({ noServer: true });
const { setupHoldemWss } = require('./holdem-server');
setupHoldemWss(wss_holdem);

// ── WS ROUTING ────────────────────────────────────────────────
server.on('upgrade', (req, socket, head) => {
  if (req.url === '/ws/bj') {
    wss_bj.handleUpgrade(req, socket, head, ws => wss_bj.emit('connection', ws, req));
  } else if (req.url === '/ws/holdem') {
    wss_holdem.handleUpgrade(req, socket, head, ws => wss_holdem.emit('connection', ws, req));
  } else {
    socket.destroy();
  }
});

// ══════════════════════════════════════════════════════════════
//  BLACKJACK GAME LOGIC (casino + torneo)
// ══════════════════════════════════════════════════════════════

const ALLOWED_START_AMOUNTS = [100,500,1000,2000,5000,10000];
const ALLOWED_REBUY_AMOUNTS  = [100,500,1000,2000,5000,10000];
const MIN_BET = 50;
const RESHUFFLE_THRESHOLD = 40;

let state = {
  phase:'lobby', gameMode:'casino',
  players:{}, dealer:{hand:[]},
  deck:[], order:[],
  currentPlayerIdx:0, currentHandIdx:0,
  insuranceTimer:null, pendingRebuy:null, potTotal:0,
};

function createDeck() {
  const suits=['S','H','D','C'];
  const sym={S:'♠',H:'♥',D:'♦',C:'♣'};
  const ranks=['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  let d=[];
  for (const s of suits) for (const r of ranks) d.push({suit:sym[s],rank:r});
  let full=[];
  for (let i=0;i<6;i++) full=full.concat(d);
  for (let i=full.length-1;i>0;i--) { const j=Math.floor(Math.random()*(i+1)); [full[i],full[j]]=[full[j],full[i]]; }
  return full;
}
function reshuffleAndReorder() {
  state.deck=createDeck();
  const ids=Object.keys(state.players);
  if (ids.length>0) { state.order=ids.sort(()=>Math.random()-.5); bjChat('🃏 Nuevo mazo barajado y lugares cambiados'); }
}
function draw() { if (state.deck.length<RESHUFFLE_THRESHOLD) reshuffleAndReorder(); return state.deck.pop(); }
function rankVal(r) { if (r==='A') return 11; if (['J','Q','K'].includes(r)) return 10; return parseInt(r); }
function handValue(cards) { let t=0,a=0; for(const c of cards){t+=rankVal(c.rank);if(c.rank==='A')a++;} while(t>21&&a>0){t-=10;a--;} return t; }
function isBlackjack(cards) { return cards.length===2&&handValue(cards)===21; }
function checkPP(c1,c2) {
  if (c1.rank!==c2.rank) return null;
  if (c1.suit===c2.suit) return {combo:'perfect',label:'Par Perfecto',payout:25};
  const red=['♥','♦'];
  if (red.includes(c1.suit)===red.includes(c2.suit)) return {combo:'colored',label:'Par de Color',payout:12};
  return {combo:'mixed',label:'Par Mixto',payout:5};
}
function ro(r){const m={A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13};return m[r]||0;}
function check213(p1,p2,dUp) {
  const c=[p1,p2,dUp],rs=c.map(x=>x.rank),ss=c.map(x=>x.suit),vs=c.map(x=>ro(x.rank)).sort((a,b)=>a-b);
  const sameSuit=ss[0]===ss[1]&&ss[1]===ss[2],sameRank=rs[0]===rs[1]&&rs[1]===rs[2];
  const consec=vs[1]-vs[0]===1&&vs[2]-vs[1]===1,aceHigh=vs[0]===1&&vs[1]===12&&vs[2]===13;
  const isStraight=consec||aceHigh;
  if(sameSuit&&sameRank)   return{combo:'suited-trips',  label:'Trío de Palo',     payout:100};
  if(isStraight&&sameSuit) return{combo:'straight-flush',label:'Escalera de Color', payout:40};
  if(sameRank)             return{combo:'three-of-kind', label:'Trío',              payout:30};
  if(isStraight)           return{combo:'straight',      label:'Escalera',          payout:10};
  if(sameSuit)             return{combo:'flush',         label:'Color',             payout:5};
  return null;
}

function bjBroadcast(msg){const d=JSON.stringify(msg);for(const id in state.players){const ws=state.players[id].ws;if(ws&&ws.readyState===WebSocket.OPEN)ws.send(d);}}
function bjSendState(hide=true){bjBroadcast({type:'state',state:bjPublic(hide)});}
function bjChat(text,system=true){bjBroadcast({type:'chat',text,system});}
function bjToPlayer(id,msg){const ws=state.players[id]?.ws;if(ws&&ws.readyState===WebSocket.OPEN)ws.send(JSON.stringify(msg));}

function bjPublic(hide=true) {
  const players={};
  for (const id in state.players) {
    const p=state.players[id];
    let hands=[];
    if (p.hands) {
      hands=p.hands.map(hand=>{
        const cc=hand.cards.map(c=>({...c}));
        if(state.gameMode==='tournament'&&state.phase!=='results'&&state.phase!=='dealer'&&!hand.fromSplit&&cc.length>=2) cc[1].hidden=true;
        return{...hand,cards:cc};
      });
    }
    players[id]={id:p.id,name:p.name,balance:p.balance,status:p.status,hands,currentHandIdx:p.currentHandIdx,
      sidebet21_3:p.sidebet21_3,sidebetPP:p.sidebetPP,result21_3:p.result21_3,resultPP:p.resultPP,
      insuranceBet:p.insuranceBet,insuranceDecided:p.insuranceDecided};
  }
  const showHole=!hide||state.phase==='dealer'||state.phase==='results';
  const dh=showHole?state.dealer.hand:state.dealer.hand.length>0?[state.dealer.hand[0],{suit:'?',rank:'?'}]:[];
  return{phase:state.phase,gameMode:state.gameMode,players,
    dealer:{hand:dh,value:showHole?handValue(state.dealer.hand):null},
    order:state.order,currentPlayerIdx:state.currentPlayerIdx,currentHandIdx:state.currentHandIdx,
    currentPlayerId:state.order[state.currentPlayerIdx]||null,
    pendingRebuy:state.pendingRebuy?{playerId:state.pendingRebuy.playerId,playerName:state.players[state.pendingRebuy.playerId]?.name,amount:state.pendingRebuy.amount,votes:state.pendingRebuy.votes}:null,
    potTotal:state.gameMode==='tournament'?state.potTotal:undefined};
}

function allReady(){const ps=Object.values(state.players);return ps.length>0&&ps.every(p=>p.status==='ready');}

function startRound() {
  if (!state.deck.length||state.deck.length<RESHUFFLE_THRESHOLD) reshuffleAndReorder();
  else { const ids=Object.keys(state.players); if(ids.length>0) state.order=ids.sort(()=>Math.random()-.5); }
  state.dealer.hand=[]; state.currentPlayerIdx=0; state.currentHandIdx=0;
  for (const id of state.order) {
    const p=state.players[id];
    p.currentHandIdx=0;p.result21_3=null;p.resultPP=null;p.insuranceBet=0;p.insuranceDecided=false;p.status='playing';
    p.hands=[{cards:[],bet:p.pendingBet,status:'playing',doubled:false,fromSplit:false}];p.pendingBet=0;
  }
  for (let r=0;r<2;r++) for (const id of state.order) state.players[id].hands[0].cards.push(draw());
  if (state.gameMode==='casino') for (let r=0;r<2;r++) state.dealer.hand.push(draw());
  const dUp=state.dealer.hand[0]||null;
  for (const id of state.order) {
    const p=state.players[id];const[c1,c2]=p.hands[0].cards;
    if(p.sidebetPP>0){const r=checkPP(c1,c2);if(r){p.balance+=p.sidebetPP*(r.payout+1);p.resultPP={...r,win:p.sidebetPP*r.payout};}else{p.resultPP={combo:null,label:'Sin par',win:-p.sidebetPP};}p.sidebetPP=0;}
    if(state.gameMode==='casino'&&p.sidebet21_3>0&&dUp){const r=check213(c1,c2,dUp);if(r){p.balance+=p.sidebet21_3*(r.payout+1);p.result21_3={...r,win:p.sidebet21_3*r.payout};}else{p.result21_3={combo:null,label:'Sin combinación',win:-p.sidebet21_3};}p.sidebet21_3=0;}
    if(isBlackjack([c1,c2]))p.hands[0].status='blackjack';
  }
  if(state.gameMode==='tournament'){let rp=0;for(const id of state.order)rp+=state.players[id].hands[0].bet;state.potTotal+=rp;bjSendState(true);}
  if(state.gameMode==='casino'&&dUp){const up=dUp.rank;if(up==='A'||['10','J','Q','K'].includes(up)){state.phase='insurance';bjSendState(true);state.insuranceTimer=setTimeout(resolveInsurance,15000);return;}}
  state.phase='playing';advanceToNextHand();
}

function resolveInsurance() {
  if(state.insuranceTimer){clearTimeout(state.insuranceTimer);state.insuranceTimer=null;}
  const dBJ=handValue(state.dealer.hand)===21&&state.dealer.hand.length===2;
  for(const id of state.order){const p=state.players[id];if(!p)continue;if(p.insuranceBet>0&&dBJ)p.balance+=p.insuranceBet*3;if(dBJ){for(const h of p.hands){if(h.status==='blackjack'){p.balance+=h.bet;h.status='push';}else h.status='lose';}p.status='done';}}
  if(dBJ){bjChat('🃏 ¡El Dealer tiene Blackjack!');state.phase='results';bjSendState(false);scheduleNextBetting();}else{state.phase='playing';advanceToNextHand();}
}
function advanceToNextHand() {
  while(state.currentPlayerIdx<state.order.length){
    const id=state.order[state.currentPlayerIdx];const p=state.players[id];
    if(!p){state.currentPlayerIdx++;state.currentHandIdx=0;continue;}
    while(state.currentHandIdx<p.hands.length){if(p.hands[state.currentHandIdx].status==='playing')break;state.currentHandIdx++;}
    if(state.currentHandIdx<p.hands.length&&p.hands[state.currentHandIdx].status==='playing'){bjSendState();return;}
    p.status='done';state.currentPlayerIdx++;state.currentHandIdx=0;
  }
  dealerTurn();
}
function dealerTurn() {
  state.phase='dealer';bjSendState(false);
  if(state.gameMode==='tournament'){setTimeout(()=>resolveRoundTournament(),2000);return;}
  const tick=setInterval(()=>{if(handValue(state.dealer.hand)<17){state.dealer.hand.push(draw());bjSendState(false);}else{clearInterval(tick);resolveRoundCasino();}},950);
}
function resolveRoundCasino() {
  state.phase='results';const dv=handValue(state.dealer.hand);const dBust=dv>21;
  for(const id of state.order){const p=state.players[id];if(!p)continue;for(const h of p.hands){const pv=handValue(h.cards);if(['bust','lose','surrender','push'].includes(h.status))continue;if(h.status==='blackjack'){p.balance+=Math.floor(h.bet*2.5);h.status='blackjack-win';}else if(dBust||pv>dv){p.balance+=h.bet*2;h.status='win';}else if(pv===dv){p.balance+=h.bet;h.status='push';}else{h.status='lose';}}}
  bjSendState(false);scheduleNextBetting();
}
function resolveRoundTournament() {
  state.phase='results';bjSendState(false);
  const ph=[];
  for(const id of state.order){const p=state.players[id];if(!p)continue;for(let hi=0;hi<p.hands.length;hi++){const h=p.hands[hi];const pv=handValue(h.cards);if(h.status==='bust'||h.status==='surrender')continue;ph.push({playerId:id,player:p,handIdx:hi,hand:h,value:pv,isBJ:h.status==='blackjack',isBust:pv>21});}}
  if(ph.length===0||ph.every(x=>x.isBust)){bjChat(`💀 Todos se pasaron! Pozo $${state.potTotal} acumulado`);bjBroadcast({type:'tournament_results',noWinner:true,potCarry:state.potTotal});bjSendState(false);scheduleNextBetting();return;}
  ph.sort((a,b)=>{if(a.isBust&&!b.isBust)return 1;if(!a.isBust&&b.isBust)return -1;if(a.isBJ&&!b.isBJ)return -1;if(!a.isBJ&&b.isBJ)return 1;return b.value-a.value;});
  const groups=[];
  for(const x of ph){if(x.isBust)continue;let g=groups.find(g=>g.value===x.value&&g.isBJ===x.isBJ);if(!g){g={value:x.value,isBJ:x.isBJ,hands:[]};groups.push(g);}g.hands.push(x);}
  const ac=ph.filter(x=>!x.isBust).length;let pcts=ac===1?[1]:ac===2?[0.6,0.4]:[0.5,0.3,0.2];
  const tot=state.potTotal;const results=[];let rem=tot;
  for(let i=0;i<Math.min(groups.length,pcts.length);i++){const g=groups[i];const share=Math.floor(tot*pcts[i]);const per=Math.floor(share/g.hands.length);for(const x of g.hands){x.player.balance+=per;x.hand.status='win';x.hand.winAmount=per;results.push({name:x.player.name,win:per,place:i+1});bjChat(`🏆 ${x.player.name} gana $${per} (${i+1}º)`);} rem-=share;}
  if(rem>0&&groups[0])for(const x of groups[0].hands){x.player.balance+=Math.floor(rem/groups[0].hands.length);}
  for(const x of ph){if(!x.hand.status||x.hand.status==='playing')x.hand.status='lose';}
  bjBroadcast({type:'tournament_results',results:results.slice(0,3)});
  state.potTotal=0;bjSendState(false);scheduleNextBetting();
}
function scheduleNextBetting() {
  setTimeout(()=>{state.phase='betting';for(const id in state.players){const p=state.players[id];p.hands=[];p.status='waiting';p.pendingBet=0;p.sidebet21_3=0;p.sidebetPP=0;p.result21_3=null;p.resultPP=null;p.insuranceBet=0;p.insuranceDecided=false;p.currentHandIdx=0;}bjSendState();},7000);
}

// Rebuy
function startRebuyVote(pid,amount) {
  if(state.pendingRebuy){bjToPlayer(pid,{type:'error',text:'Ya hay votación activa'});return;}
  const p=state.players[pid];if(!p)return;
  if(!ALLOWED_REBUY_AMOUNTS.includes(amount)){bjToPlayer(pid,{type:'error',text:'Monto no válido'});return;}
  const others=Object.keys(state.players).filter(id=>id!==pid);
  if(others.length===0){p.balance+=amount;bjChat(`${p.name} compró $${amount}`);bjToPlayer(pid,{type:'rebuy_complete',amount});bjSendState();return;}
  state.pendingRebuy={playerId:pid,amount,votes:{},voters:[...others]};
  bjChat(`🗳️ ${p.name} solicita $${amount} de recompra (30s).`);
  for(const id of others) bjToPlayer(id,{type:'rebuy_vote_request',playerName:p.name,amount});
  setTimeout(()=>{if(state.pendingRebuy?.playerId===pid)resolveRebuyVote();},30000);
  bjSendState();
}
function resolveRebuyVote() {
  if(!state.pendingRebuy)return;
  const{playerId,amount,votes,voters}=state.pendingRebuy;
  const p=state.players[playerId];
  const yes=Object.values(votes).filter(v=>v).length,no=Object.values(votes).filter(v=>!v).length;
  const approved=Object.keys(votes).length>0&&yes>no;
  if(approved&&p){p.balance+=amount;bjChat(`✅ ${p.name} compró $${amount}`);bjToPlayer(playerId,{type:'rebuy_complete',amount});}
  else if(p){bjChat(`❌ Rechazada recompra de ${p.name}`);bjToPlayer(playerId,{type:'rebuy_denied'});}
  for(const id of voters) bjToPlayer(id,{type:'rebuy_vote_closed',approved});
  state.pendingRebuy=null;bjSendState();
}

// WS handlers
wss_bj.on('connection',(ws)=>{
  let myId=null;
  let isAlive=true;
  const pingInterval = setInterval(()=>{
    if (!isAlive) { ws.terminate(); return; }
    isAlive=false;
    ws.ping();
  },30000);
  ws.on('pong',()=>{ isAlive=true; });

  ws.on('message',(raw)=>{
    let msg;try{msg=JSON.parse(raw);}catch{return;}
    if(msg.type==='join'){
      if(Object.keys(state.players).length>=5){ws.send(JSON.stringify({type:'error',text:'Mesa llena (máx 5)'}));return;}
      const name=String(msg.name||'Jugador').slice(0,16).trim()||'Jugador';
      const existingId = Object.keys(state.players).find(id =>
        state.players[id].name.toLowerCase() === name.toLowerCase()
      );
      if (existingId) {
        const oldWs = state.players[existingId].ws;
        if (oldWs && oldWs.readyState === WebSocket.OPEN) {
          oldWs.close(1000, 'Replaced by new connection');
        }
        delete state.players[existingId];
        state.order = state.order.filter(id => id !== existingId);
        bjChat(`👋 ${name} se ha reconectado (reemplazando sesión anterior)`);
      }
      const sa=parseInt(msg.startAmount);
      if(!ALLOWED_START_AMOUNTS.includes(sa)){ws.send(JSON.stringify({type:'error',text:'Monto no válido'}));return;}
      const reqMode=msg.gameMode||'casino';
      if(Object.keys(state.players).length===0){state.gameMode=reqMode;bjChat(`🎮 Modo: ${reqMode==='casino'?'Casino':'Torneo'}`);if(!state.deck.length)reshuffleAndReorder();}
      else if(state.gameMode!==reqMode){ws.send(JSON.stringify({type:'error',text:`Mesa en modo ${state.gameMode==='casino'?'Casino':'Torneo'}`}));return;}
      myId=`bj${Date.now().toString(36)}${Math.random().toString(36).slice(2,4)}`;
      state.players[myId]={id:myId,name,balance:sa,ws,status:'waiting',hands:[],pendingBet:0,sidebet21_3:0,sidebetPP:0,result21_3:null,resultPP:null,insuranceBet:0,insuranceDecided:false,currentHandIdx:0};
      ws.send(JSON.stringify({type:'joined',id:myId,balance:sa}));
      if(state.phase==='lobby')state.phase='betting';
      bjSendState();bjChat(`${name} se unió con $${sa} 🃏`);return;
    }
    if(!myId||!state.players[myId])return;
    const player=state.players[myId];
    if(msg.type==='bet'){
      if(state.phase!=='betting'||player.status==='ready')return;
      const main=parseInt(msg.main)||0,pp=parseInt(msg.pp)||0,s21=parseInt(msg.s21)||0;
      if(main<MIN_BET){bjToPlayer(myId,{type:'error',text:`Mínimo $${MIN_BET}`});return;}
      if((main+pp+s21)>player.balance){bjToPlayer(myId,{type:'error',text:'No tienes suficientes fichas'});return;}
      player.balance-=(main+pp+s21);player.pendingBet=main;player.sidebetPP=pp;player.sidebet21_3=s21;player.status='ready';
      let t=`${player.name} apostó $${main}`;if(pp>0)t+=` · PP $${pp}`;if(s21>0&&state.gameMode==='casino')t+=` · 21+3 $${s21}`;bjChat(t);
      if(allReady())setTimeout(startRound,1200);else bjSendState();return;
    }
    if(msg.type==='insurance'){if(state.gameMode!=='casino')return;if(state.phase!=='insurance'||player.insuranceDecided)return;player.insuranceDecided=true;if(msg.take){const ib=Math.ceil((player.hands[0]?.bet||0)/2);if(player.balance>=ib){player.balance-=ib;player.insuranceBet=ib;bjChat(`${player.name} tomó seguro ($${ib})`);}}else bjChat(`${player.name} rechazó el seguro`);if(Object.values(state.players).every(p=>p.insuranceDecided))resolveInsurance();else bjSendState();return;}
    if(msg.type==='rebuy_request'){if(state.phase!=='betting'&&state.phase!=='lobby'){bjToPlayer(myId,{type:'error',text:'Solo entre rondas'});return;}startRebuyVote(myId,parseInt(msg.amount));return;}
    if(msg.type==='rebuy_vote'){if(state.pendingRebuy){if(state.pendingRebuy.votes[myId]===undefined&&state.pendingRebuy.voters.includes(myId)){state.pendingRebuy.votes[myId]=msg.approve;bjChat(`${player.name} ${msg.approve?'aprobó':'rechazó'} la recompra`);if(Object.keys(state.pendingRebuy.votes).length===state.pendingRebuy.voters.length)resolveRebuyVote();}else bjToPlayer(myId,{type:'error',text:'Ya votaste'});}return;}
    if(msg.type==='chat'){const t=String(msg.text||'').slice(0,120).trim();if(t)bjBroadcast({type:'chat',text:`${player.name}: ${t}`,system:false});return;}
    if(!['hit','stand','double','split','surrender'].includes(msg.type))return;
    if(state.phase!=='playing'||state.order[state.currentPlayerIdx]!==myId)return;
    const hand=player.hands[state.currentHandIdx];
    if(!hand||hand.status!=='playing')return;
    if(msg.type==='hit'){hand.cards.push(draw());const v=handValue(hand.cards);if(v>21){hand.status='bust';state.currentHandIdx++;advanceToNextHand();}else if(v===21){hand.status='stand';state.currentHandIdx++;advanceToNextHand();}else bjSendState();}
    else if(msg.type==='stand'){hand.status='stand';state.currentHandIdx++;advanceToNextHand();}
    else if(msg.type==='double'){if(hand.cards.length!==2||player.balance<hand.bet)return;player.balance-=hand.bet;hand.bet*=2;hand.doubled=true;hand.cards.push(draw());if(state.gameMode==='tournament')state.potTotal+=hand.bet/2;hand.status=handValue(hand.cards)>21?'bust':'stand';state.currentHandIdx++;advanceToNextHand();}
    else if(msg.type==='split'){if(hand.cards.length!==2)return;const[c1,c2]=hand.cards;if(rankVal(c1.rank)!==rankVal(c2.rank)||player.balance<hand.bet||player.hands.length>=4)return;const isAce=c1.rank==='A';player.balance-=hand.bet;if(state.gameMode==='tournament')state.potTotal+=hand.bet;hand.cards=[c1,draw()];if(isAce||handValue(hand.cards)===21)hand.status='stand';const nh={cards:[c2,draw()],bet:hand.bet,status:'playing',doubled:false,fromSplit:true};if(isAce||handValue(nh.cards)===21)nh.status='stand';player.hands.splice(state.currentHandIdx+1,0,nh);if(hand.status==='playing')bjSendState();else advanceToNextHand();}
    else if(msg.type==='surrender'){if(hand.cards.length!==2||hand.fromSplit||player.hands.length>1)return;const ref=Math.floor(hand.bet/2);player.balance+=ref;if(state.gameMode==='tournament')state.potTotal-=ref;hand.status='surrender';state.currentHandIdx++;advanceToNextHand();}
  });
  ws.on('close',()=>{
    clearInterval(pingInterval);
    if(myId&&state.players[myId]){const name=state.players[myId].name;delete state.players[myId];bjChat(`${name} dejó la mesa`);if(state.phase==='playing')advanceToNextHand();else if(state.phase==='insurance'&&Object.values(state.players).every(p=>p.insuranceDecided))resolveInsurance();if(Object.keys(state.players).length===0)state.phase='lobby';bjSendState();}
  });
});

// ── START ────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
server.listen(PORT, () => {
  const { networkInterfaces } = require('os');
  console.log(`\n♠  Casino Local — Servidor Unificado\n${'─'.repeat(44)}`);
  console.log(`   Local:    http://localhost:${PORT}`);
  for (const name of Object.keys(networkInterfaces()))
    for (const net of networkInterfaces()[name])
      if (net.family==='IPv4'&&!net.internal)
        console.log(`   Red LAN:  http://${net.address}:${PORT}  ← comparte esta`);
  console.log(`${'─'.repeat(44)}`);
  console.log(`   Rutas:`);
  console.log(`   /           → Menú principal`);
  console.log(`   /blackjack  → Blackjack (Casino / Torneo)`);
  console.log(`   /holdem     → Texas Hold'em`);
  console.log(`${'─'.repeat(44)}\n`);
});
