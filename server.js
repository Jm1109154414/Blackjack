const WebSocket = require('ws');
const http = require('http');
const fs = require('fs');
const path = require('path');

const server = http.createServer((req, res) => {
  if (req.url === '/' || req.url === '/index.html') {
    fs.readFile(path.join(__dirname, 'index.html'), (err, data) => {
      if (err) { res.writeHead(404); res.end('Not found'); return; }
      res.writeHead(200, { 'Content-Type': 'text/html' });
      res.end(data);
    });
  }
});

const wss = new WebSocket.Server({ server });

let state = {
  phase: 'lobby',
  players: {},
  dealer: { hand: [] },
  deck: [],
  order: [],
  currentPlayerIdx: 0,
  currentHandIdx: 0,
  insuranceTimer: null,
};

function createDeck() {
  const suits = ['S','H','D','C'];
  const suitSymbol = {S:'♠',H:'♥',D:'♦',C:'♣'};
  const ranks = ['A','2','3','4','5','6','7','8','9','10','J','Q','K'];
  let deck = [];
  for (let s of suits) for (let r of ranks) deck.push({ suit: suitSymbol[s], rank: r });
  let full = [];
  for (let i = 0; i < 6; i++) full = full.concat(deck);
  for (let i = full.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [full[i], full[j]] = [full[j], full[i]];
  }
  return full;
}

function draw() {
  if (state.deck.length < 40) state.deck = createDeck();
  return state.deck.pop();
}

function rankVal(rank) {
  if (rank === 'A') return 11;
  if (['J','Q','K'].includes(rank)) return 10;
  return parseInt(rank);
}

function handValue(cards) {
  let total = 0, aces = 0;
  for (const c of cards) { total += rankVal(c.rank); if (c.rank === 'A') aces++; }
  while (total > 21 && aces > 0) { total -= 10; aces--; }
  return total;
}

function checkPerfectPairs(c1, c2) {
  if (c1.rank !== c2.rank) return null;
  if (c1.suit === c2.suit) return { combo: 'perfect', label: 'Par Perfecto', payout: 25 };
  const red = ['♥','♦'];
  if (red.includes(c1.suit) === red.includes(c2.suit)) return { combo: 'colored', label: 'Par de Color', payout: 12 };
  return { combo: 'mixed', label: 'Par Mixto', payout: 5 };
}

function rankOrder(rank) {
  const m = {A:1,'2':2,'3':3,'4':4,'5':5,'6':6,'7':7,'8':8,'9':9,'10':10,J:11,Q:12,K:13};
  return m[rank] || 0;
}

function check21plus3(p1, p2, dUp) {
  const cards = [p1, p2, dUp];
  const ranks = cards.map(c => c.rank);
  const suits = cards.map(c => c.suit);
  const vals  = cards.map(c => rankOrder(c.rank)).sort((a,b) => a-b);
  const sameSuit   = suits[0]===suits[1] && suits[1]===suits[2];
  const sameRank   = ranks[0]===ranks[1] && ranks[1]===ranks[2];
  const consec     = vals[1]-vals[0]===1 && vals[2]-vals[1]===1;
  const aceHigh    = vals[0]===1 && vals[1]===12 && vals[2]===13;
  const isStraight = consec || aceHigh;
  if (sameSuit && sameRank)   return { combo:'suited-trips',   label:'Trío de Palo',      payout:100 };
  if (isStraight && sameSuit) return { combo:'straight-flush', label:'Escalera de Color',  payout:40  };
  if (sameRank)               return { combo:'three-of-kind',  label:'Trío',               payout:30  };
  if (isStraight)             return { combo:'straight',       label:'Escalera',            payout:10  };
  if (sameSuit)               return { combo:'flush',          label:'Color',               payout:5   };
  return null;
}

function publicState(hideHole = true) {
  const players = {};
  for (const id in state.players) {
    const p = state.players[id];
    players[id] = {
      id:p.id, name:p.name, balance:p.balance, status:p.status,
      hands:p.hands, currentHandIdx:p.currentHandIdx,
      sidebet21_3:p.sidebet21_3, sidebetPP:p.sidebetPP,
      result21_3:p.result21_3, resultPP:p.resultPP,
      insuranceBet:p.insuranceBet, insuranceDecided:p.insuranceDecided,
    };
  }
  const showHole = !hideHole || state.phase==='dealer' || state.phase==='results';
  const dealerHand = showHole ? state.dealer.hand
    : state.dealer.hand.length>0 ? [state.dealer.hand[0],{suit:'?',rank:'?'}] : [];
  return {
    phase:state.phase, players,
    dealer:{ hand:dealerHand, value: showHole ? handValue(state.dealer.hand) : null },
    order:state.order,
    currentPlayerIdx:state.currentPlayerIdx, currentHandIdx:state.currentHandIdx,
    currentPlayerId:state.order[state.currentPlayerIdx]||null,
  };
}

function broadcast(msg) {
  const data = JSON.stringify(msg);
  for (const id in state.players) {
    const ws = state.players[id].ws;
    if (ws && ws.readyState===WebSocket.OPEN) ws.send(data);
  }
}
function sendState(hideHole=true) { broadcast({type:'state',state:publicState(hideHole)}); }
function chat(text,system=true) { broadcast({type:'chat',text,system}); }
function allReady() {
  const ps = Object.values(state.players);
  return ps.length>0 && ps.every(p=>p.status==='ready');
}

function startRound() {
  state.deck = createDeck();
  state.dealer.hand = [];
  state.order = Object.keys(state.players);
  state.currentPlayerIdx = 0; state.currentHandIdx = 0;
  for (const id of state.order) {
    const p = state.players[id];
    p.currentHandIdx=0; p.result21_3=null; p.resultPP=null;
    p.insuranceBet=0; p.insuranceDecided=false; p.status='playing';
    p.hands=[{cards:[],bet:p.pendingBet,status:'playing',doubled:false,fromSplit:false}];
    p.pendingBet=0;
  }
  for (let round=0;round<2;round++) {
    for (const id of state.order) state.players[id].hands[0].cards.push(draw());
    state.dealer.hand.push(draw());
  }
  const dUp = state.dealer.hand[0];
  for (const id of state.order) {
    const p = state.players[id];
    const [c1,c2] = p.hands[0].cards;
    if (p.sidebetPP>0) {
      const r = checkPerfectPairs(c1,c2);
      if (r) { p.balance+=p.sidebetPP*(r.payout+1); p.resultPP={...r,win:p.sidebetPP*r.payout}; }
      else   { p.resultPP={combo:null,label:'Sin par',win:-p.sidebetPP}; }
      p.sidebetPP=0;
    }
    if (p.sidebet21_3>0) {
      const r = check21plus3(c1,c2,dUp);
      if (r) { p.balance+=p.sidebet21_3*(r.payout+1); p.result21_3={...r,win:p.sidebet21_3*r.payout}; }
      else   { p.result21_3={combo:null,label:'Sin combinación',win:-p.sidebet21_3}; }
      p.sidebet21_3=0;
    }
    if (handValue([c1,c2])===21) p.hands[0].status='blackjack';
  }
  if (dUp.rank==='A') {
    state.phase='insurance'; sendState(true);
    state.insuranceTimer=setTimeout(resolveInsurance,15000);
  } else {
    state.phase='playing'; advanceToNextHand();
  }
}

function resolveInsurance() {
  if (state.insuranceTimer) { clearTimeout(state.insuranceTimer); state.insuranceTimer=null; }
  const dealerBJ = handValue(state.dealer.hand)===21 && state.dealer.hand.length===2;
  for (const id of state.order) {
    const p=state.players[id]; if (!p) continue;
    if (p.insuranceBet>0 && dealerBJ) p.balance+=p.insuranceBet*3;
    if (dealerBJ) {
      for (const hand of p.hands) {
        if (hand.status==='blackjack') { p.balance+=hand.bet; hand.status='push'; }
        else hand.status='lose';
      }
      p.status='done';
    }
  }
  if (dealerBJ) {
    chat('🃏 ¡El Dealer tiene Blackjack!');
    state.phase='results'; sendState(false); scheduleNextBetting();
  } else {
    state.phase='playing'; advanceToNextHand();
  }
}

function advanceToNextHand() {
  while (state.currentPlayerIdx<state.order.length) {
    const id=state.order[state.currentPlayerIdx];
    const p=state.players[id];
    if (!p) { state.currentPlayerIdx++; state.currentHandIdx=0; continue; }
    while (state.currentHandIdx<p.hands.length) {
      if (p.hands[state.currentHandIdx].status==='playing') break;
      state.currentHandIdx++;
    }
    if (state.currentHandIdx<p.hands.length && p.hands[state.currentHandIdx].status==='playing') {
      sendState(); return;
    }
    p.status='done'; state.currentPlayerIdx++; state.currentHandIdx=0;
  }
  dealerTurn();
}

function dealerTurn() {
  state.phase='dealer'; sendState(false);
  const tick=setInterval(()=>{
    if (handValue(state.dealer.hand)<17) { state.dealer.hand.push(draw()); sendState(false); }
    else { clearInterval(tick); resolveRound(); }
  },950);
}

function resolveRound() {
  state.phase='results';
  const dv=handValue(state.dealer.hand); const dealerBust=dv>21;
  for (const id of state.order) {
    const p=state.players[id]; if (!p) continue;
    for (const hand of p.hands) {
      const pv=handValue(hand.cards);
      if (['bust','lose','surrender','push'].includes(hand.status)) continue;
      if (hand.status==='blackjack') { p.balance+=Math.floor(hand.bet*2.5); hand.status='blackjack-win'; }
      else if (dealerBust||pv>dv)   { p.balance+=hand.bet*2;               hand.status='win'; }
      else if (pv===dv)              { p.balance+=hand.bet;                  hand.status='push'; }
      else                           { hand.status='lose'; }
    }
  }
  sendState(false); scheduleNextBetting();
}

function scheduleNextBetting() {
  setTimeout(()=>{
    state.phase='betting';
    for (const id in state.players) {
      const p=state.players[id];
      p.hands=[]; p.status='waiting'; p.pendingBet=0; p.sidebet21_3=0; p.sidebetPP=0;
      p.result21_3=null; p.resultPP=null; p.insuranceBet=0; p.insuranceDecided=false; p.currentHandIdx=0;
    }
    sendState();
  },7000);
}

wss.on('connection',(ws)=>{
  let myId=null;
  ws.on('message',(raw)=>{
    let msg; try{msg=JSON.parse(raw);}catch{return;}
    if (msg.type==='join') {
      if (Object.keys(state.players).length>=5) { ws.send(JSON.stringify({type:'error',text:'Mesa llena (máx 5)'})); return; }
      const name=String(msg.name||'Jugador').slice(0,16).trim()||'Jugador';
      myId=`${Date.now().toString(36)}${Math.random().toString(36).slice(2,5)}`;
      state.players[myId]={id:myId,name,balance:1000,ws,status:'waiting',hands:[],pendingBet:0,
        sidebet21_3:0,sidebetPP:0,result21_3:null,resultPP:null,insuranceBet:0,insuranceDecided:false,currentHandIdx:0};
      ws.send(JSON.stringify({type:'joined',id:myId}));
      if (state.phase==='lobby') state.phase='betting';
      sendState(); chat(`${name} se unió a la mesa 🃏`); return;
    }
    if (!myId||!state.players[myId]) return;
    const player=state.players[myId];
    if (msg.type==='bet') {
      if (state.phase!=='betting'||player.status==='ready') return;
      const main=parseInt(msg.main)||0, pp=parseInt(msg.pp)||0, s21=parseInt(msg.s21)||0;
      if (main<1||(main+pp+s21)>player.balance) return;
      player.balance-=(main+pp+s21); player.pendingBet=main; player.sidebetPP=pp; player.sidebet21_3=s21; player.status='ready';
      let t=`${player.name} apostó $${main}`; if(pp>0)t+=` · PP $${pp}`; if(s21>0)t+=` · 21+3 $${s21}`; chat(t);
      if (allReady()) setTimeout(startRound,1200); else sendState(); return;
    }
    if (msg.type==='insurance') {
      if (state.phase!=='insurance'||player.insuranceDecided) return;
      player.insuranceDecided=true;
      if (msg.take) {
        const ib=Math.ceil((player.hands[0]?.bet||0)/2);
        if (player.balance>=ib) { player.balance-=ib; player.insuranceBet=ib; chat(`${player.name} tomó seguro ($${ib})`); }
      } else chat(`${player.name} rechazó el seguro`);
      if (Object.values(state.players).every(p=>p.insuranceDecided)) resolveInsurance(); else sendState(); return;
    }
    if (msg.type==='chat') { const t=String(msg.text||'').slice(0,120).trim(); if(t)broadcast({type:'chat',text:`${player.name}: ${t}`,system:false}); return; }
    if (!['hit','stand','double','split','surrender'].includes(msg.type)) return;
    if (state.phase!=='playing'||state.order[state.currentPlayerIdx]!==myId) return;
    const hand=player.hands[state.currentHandIdx];
    if (!hand||hand.status!=='playing') return;
    if (msg.type==='hit') {
      hand.cards.push(draw()); const v=handValue(hand.cards);
      if (v>21){hand.status='bust';state.currentHandIdx++;advanceToNextHand();}
      else if(v===21){hand.status='stand';state.currentHandIdx++;advanceToNextHand();}
      else sendState();
    } else if (msg.type==='stand') {
      hand.status='stand'; state.currentHandIdx++; advanceToNextHand();
    } else if (msg.type==='double') {
      if (hand.cards.length!==2||player.balance<hand.bet) return;
      player.balance-=hand.bet; hand.bet*=2; hand.doubled=true; hand.cards.push(draw());
      hand.status=handValue(hand.cards)>21?'bust':'stand'; state.currentHandIdx++; advanceToNextHand();
    } else if (msg.type==='split') {
      if (hand.cards.length!==2) return;
      const [c1,c2]=hand.cards;
      if (rankVal(c1.rank)!==rankVal(c2.rank)||player.balance<hand.bet||player.hands.length>=4) return;
      const isAce=c1.rank==='A'; player.balance-=hand.bet;
      hand.cards=[c1,draw()]; if(isAce||handValue(hand.cards)===21)hand.status='stand';
      const nh={cards:[c2,draw()],bet:hand.bet,status:'playing',doubled:false,fromSplit:true};
      if(isAce||handValue(nh.cards)===21)nh.status='stand';
      player.hands.splice(state.currentHandIdx+1,0,nh);
      if (hand.status==='playing') sendState(); else advanceToNextHand();
    } else if (msg.type==='surrender') {
      if (hand.cards.length!==2||hand.fromSplit||player.hands.length>1) return;
      player.balance+=Math.floor(hand.bet/2); hand.status='surrender'; state.currentHandIdx++; advanceToNextHand();
    }
  });
  ws.on('close',()=>{
    if (myId&&state.players[myId]) {
      const name=state.players[myId].name; delete state.players[myId]; chat(`${name} dejó la mesa`);
      if (state.phase==='playing') advanceToNextHand();
      else if (state.phase==='insurance'&&Object.values(state.players).every(p=>p.insuranceDecided)) resolveInsurance();
      if (Object.keys(state.players).length===0) state.phase='lobby';
      sendState();
    }
  });
});

const PORT=3000;
server.listen(PORT,()=>{
  const {networkInterfaces}=require('os');
  console.log(`\n🃏  Blackjack Multijugador\n${'─'.repeat(40)}`);
  console.log(`   Local:   http://localhost:${PORT}`);
  for (const name of Object.keys(networkInterfaces()))
    for (const net of networkInterfaces()[name])
      if (net.family==='IPv4'&&!net.internal)
        console.log(`   Red LAN: http://${net.address}:${PORT}  ← comparte esta URL`);
  console.log(`${'─'.repeat(40)}\n`);
});
