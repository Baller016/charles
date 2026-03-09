/**
 * Digit Flow Pro — Advanced Deriv Market Analyzer
 * Production-ready WebSocket client with AI signals and technical indicators.
 */

'use strict';

// ═══════════════════════════════════════════════════════
//  CONFIG
// ═══════════════════════════════════════════════════════
const CONFIG = {
    APP_ID: 1089,
    WS_URL: 'wss://ws.binaryws.com/websockets/v3?app_id=1089',
    OAUTH_URL: 'https://oauth.deriv.com/oauth2/authorize?app_id=1089&l=en',
    RECONNECT_DELAY: 3000,
    MAX_TICK_HISTORY: 500,
    MAX_CANDLE_HISTORY: 300,
    LINE_CHART_POINTS: 100,
};

// ═══════════════════════════════════════════════════════
//  STATE
// ═══════════════════════════════════════════════════════
const state = {
    ws: null,
    symbol: '1HZ100V',
    granularity: 60,
    maPeriod: 20,
    sampleSize: 100,
    apiToken: null,
    accountInfo: null,
    accountList: [],        // All linked accounts from authorize response
    tickHistory: [],        // Array of last digit integers
    priceHistory: [],       // Array of { time, price }
    candleHistory: [],      // Array of OHLC objects
    digitCounts: new Array(10).fill(0),
    tickCount: 0,
    tickTimestamps: [],
    lastTickTime: null,
    isConnected: false,
    indicators: { ma: true, bb: true, macd: true, cci: true },
    currentMode: 'candle',  // 'candle' | 'line'
    // Charts
    candleChart: null,
    macdChart: null,
    cciChart: null,
    maSeries: null,
    bbUpperSeries: null,
    bbLowerSeries: null,
    macdLineSeries: null,
    macdSignalSeries: null,
    macdHistSeries: null,
    cciLineSeries: null,
    lineChartInstance: null,
    lastOhlcTime: 0,
    candleDigitLog: [],        // { color, zone, over5, under4, total } per closed candle
    currentCandleDigits: [],   // all digits seen during current open candle

    // Advanced AI / ML Model State (Online Learning)
    mlModel: {
        lastDigit: null,
        totalTicks: 0,
        markov: Array.from({ length: 10 }, () => new Array(10).fill(0)), // transition frequency
        ngram2: {}, // { "d1-d2": count }
        ewm: {
            digits: new Array(10).fill(10), // start with neutral prior
            odd: 50, even: 50,
            over: 50, under: 50,
            alpha: 0.05 // smoothing factor (approx 20 ticks)
        },
        predictions: {
            nextDigit: null,
            nextOU: null, // "over", "under"
            nextOE: null, // "odd", "even"
        },
        accuracy: {
            digit: [], // binary 1/0 for last N ticks
            ou: [],
            oe: []
        },
        regime: 'neutral', // 'volatile', 'trending', 'ranging'
    }
};

// Prevent race conditions from overlapping tick processing
const tickQueue = [];
let tickProcessing = false;

function enqueueTick(msg) {
    tickQueue.push(msg);
    processTickQueue();
}

async function processTickQueue() {
    if (tickProcessing) return;
    tickProcessing = true;

    while (tickQueue.length > 0) {
        const msg = tickQueue.shift();

        try {
            await routeMessage(msg);
        } catch (err) {
            console.error("Tick processing error:", err);
        }
    }

    tickProcessing = false;
}

// ═══════════════════════════════════════════════════════
//  DOM REFS
// ═══════════════════════════════════════════════════════
const $ = id => document.getElementById(id);
const DOM = {
    connRing: $('connection-ring'),
    connLabel: $('connection-label'),
    currentPrice: $('current-price'),
    headerDigit: $('header-digit'),
    tickCounter: $('tick-counter'),
    bigDigitNum: $('big-digit-num'),
    digitRing: $('digit-ring'),
    digitStream: $('digit-stream'),
    candleTimer: $('timer-val'),
    botStatus: $('bot-status'),
    signalCard: $('signal-card'),
    signalMain: $('signal-main'),
    signalSub: $('signal-sub'),
    signalConf: $('signal-conf'),
    signalStreak: $('signal-streak'),
    hotTags: $('hot-digits-tags'),
    coldTags: $('cold-digits-tags'),
    statOdd: $('stat-odd'),
    statEven: $('stat-even'),
    statOver: $('stat-over'),
    statUnder: $('stat-under'),
    barOdd: $('bar-odd'),
    barEven: $('bar-even'),
    barOver: $('bar-over'),
    barUnder: $('bar-under'),
    sampleInfo: $('sample-info'),
    freqTable: $('freq-table'),
    patternList: $('pattern-list'),
    recDigits: $('rec-digits'),
    recOE: $('rec-oe'),
    recOU: $('rec-ou'),
    recMD: $('rec-md'),
    ticksPerMin: $('ticks-per-min'),
    lastTickTime: $('last-tick-time'),
    marketVol: $('market-vol'),
    statusMsg: $('status-msg'),
    wsIndicator: $('ws-indicator'),
    wsStatusText: $('ws-status-text'),
    sampleTicksBadge: $('sample-ticks-badge'),
    sampleInfo2: $('sample-info'),
    digitDistBars: $('digit-dist-bars'),
    candlePanel: $('candle-chart-panel'),
    linePanel: $('line-chart-panel'),
    indicatorPanel: $('indicator-panel'),
    candleContainer: $('candle-chart-container'),
    macdContainer: $('macd-chart-container'),
    cciContainer: $('cci-chart-container'),
    // Bot Editor
    botPanel: $('bot-editor-panel'),
    botFileInput: $('bot-file-input'),
    botEditor: $('bot-editor-textarea'),
    downloadBotBtn: $('download-bot-btn'),
    clearBotBtn: $('clear-bot-btn'),
};

const COLORS = {
    cyan: '#00D4FF',
    purple: '#A855F7',
    green: '#22D3A4',
    red: '#F53B5C',
    orange: '#FF9F0A',
    gold: '#FFD700',
    white: '#E2E8F0',
    bgDark: '#0A0F1E',
    gridLine: 'rgba(255,255,255,0.05)',
    textMuted: '#64748B',
    bbUpper: '#4A90E2',
    bbLower: '#4A90E2',
};

// ═══════════════════════════════════════════════════════
//  WEBSOCKET
// ═══════════════════════════════════════════════════════
function connectWS() {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.close();
    }

    setStatus('Connecting to Deriv servers...', false);
    state.ws = new WebSocket(CONFIG.WS_URL);

    state.ws.onopen = () => {
        state.isConnected = true;
        setConnected(true);
        // Auto-authorize if we have a saved token
        if (state.apiToken) {
            wsSend({ authorize: state.apiToken });
        }
        subscribeSymbol(state.symbol);
    };

    state.ws.onmessage = e => {
        try {
            const msg = JSON.parse(e.data);
            enqueueTick(msg);
        } catch (err) {
            console.warn('WS parse error:', err);
        }
    };

    state.ws.onclose = () => {
        state.isConnected = false;
        setConnected(false);
        setStatus('Disconnected. Reconnecting...', false);
        setTimeout(connectWS, CONFIG.RECONNECT_DELAY);
    };

    state.ws.onerror = () => {
        setStatus('Connection error. Check your network.', false);
    };
}

function wsSend(obj) {
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        state.ws.send(JSON.stringify(obj));
    }
}

function subscribeSymbol(symbol) {
    // Unsubscribe all first
    wsSend({ forget_all: ['ticks', 'ohlc'] });

    // Reset state
    state.tickHistory = [];
    state.priceHistory = [];
    state.candleHistory = [];
    state.digitCounts = new Array(10).fill(0);
    state.tickCount = 0;
    state.tickTimestamps = [];
    state.lastOhlcTime = 0;
    state.historyLoaded = false;
    state.candleDigitLog = [];
    state.currentCandleDigits = [];

    // Reset ML Model
    state.mlModel.lastDigit = null;
    state.mlModel.totalTicks = 0;
    state.mlModel.markov = Array.from({ length: 10 }, () => new Array(10).fill(0));
    state.mlModel.ngram2 = {};
    state.mlModel.ewm.digits.fill(10);
    state.mlModel.ewm.odd = 50; state.mlModel.ewm.even = 50;
    state.mlModel.ewm.over = 50; state.mlModel.ewm.under = 50;
    state.mlModel.accuracy.digit = [];
    state.mlModel.accuracy.ou = [];
    state.mlModel.accuracy.oe = [];
    state.mlModel.regime = 'neutral';

    // Fully reinitialize charts so old series state doesn't bleed into new market
    if (state.currentMode === 'candle') {
        initCandleCharts();
    } else {
        initLineChart();
    }

    // Live ticks
    wsSend({ ticks: symbol, subscribe: 1 });

    // Live OHLC candles
    wsSend({ ticks_history: symbol, end: 'latest', style: 'candles', granularity: state.granularity, count: 200, subscribe: 1 });

    // Rebuild digit distribution
    buildDistBars();
    buildFreqTable();
}

async function routeMessage(msg) {
    if (msg.error) {
        console.warn('API Error:', msg.error.message);
        // Surface auth errors to the login modal
        if (msg.msg_type === 'authorize') {
            showLoginError('Authorization failed: ' + msg.error.message);
            resetConnectBtn();
        }
        return;
    }
    switch (msg.msg_type) {
        case 'tick': return handleTick(msg.tick);
        case 'ohlc': return handleOHLC(msg.ohlc);
        case 'candles': handleCandleHistory(msg.candles); break;
        case 'authorize': handleAuthorize(msg.authorize); break;
        case 'balance': handleBalance(msg.balance); break;
    }
}

// ═══════════════════════════════════════════════════════
//  TICK HANDLING
// ═══════════════════════════════════════════════════════
function handleTick(tick) {
    const timestamp = tick.epoch;
    if (timestamp <= state.lastOhlcTime) return;

    const price = tick.quote;
    const pipSize = tick.pip_size || 2;
    const priceStr = price.toFixed(pipSize);
    const lastDigit = parseInt(priceStr.slice(-1), 10);
    const now = Date.now();

    // Update price display
    DOM.currentPrice.textContent = priceStr;
    DOM.headerDigit.textContent = lastDigit;
    DOM.headerDigit.style.color = lastDigit % 2 === 0 ? COLORS.purple : COLORS.cyan;
    DOM.bigDigitNum.textContent = lastDigit;
    DOM.bigDigitNum.className = 'big-digit-num ' + (lastDigit % 2 === 0 ? 'even-digit' : 'odd-digit');

    // Animate digit ring
    animateDigitRing(lastDigit);

    // History tracking
    state.tickHistory.push(lastDigit);
    state.priceHistory.push({ time: tick.epoch || Math.floor(now / 1000), price });
    state.tickTimestamps.push(now);
    state.digitCounts[lastDigit]++;
    state.tickCount++;
    state.lastTickTime = now;
    state.currentCandleDigits.push(lastDigit); // accumulate for candle-digit report

    // Update ML model (Online Learning)
    updateMLModel(lastDigit);

    // Keep histories bounded
    if (state.tickHistory.length > CONFIG.MAX_TICK_HISTORY) {
        const removed = state.tickHistory.shift();
        state.digitCounts[removed] = Math.max(0, state.digitCounts[removed] - 1);
        state.priceHistory.shift();
    }
    if (state.tickTimestamps.length > 120) state.tickTimestamps.shift();

    // Add to stream
    addDigitToStream(lastDigit);

    // All UI updates
    updateTickCounter();
    updateFlowStats();
    updateFreqTable();
    updateBotSignal();
    updateSpeedMetrics(now);
    updateTradeRecs();
    updatePatterns();

    if (state.currentMode === 'line') {
        updateLineChart();
        updateDistBars();
    }
}

function handleOHLC(ohlc) {
    const candle = {
        time: ohlc.open_time,
        open: parseFloat(ohlc.open),
        high: parseFloat(ohlc.high),
        low: parseFloat(ohlc.low),
        close: parseFloat(ohlc.close),
    };

    // Update/push to history
    if (candle.time === state.lastOhlcTime) {
        // Same candle updating — just replace the last entry
        if (state.candleHistory.length > 0) {
            state.candleHistory[state.candleHistory.length - 1] = candle;
        }
    } else {
        // A new candle has started: log all digits that occurred during previous candle
        if (state.candleHistory.length > 0 && state.currentCandleDigits.length > 0) {
            recordCandleDigit(state.candleHistory[state.candleHistory.length - 1]);
        }
        state.currentCandleDigits = []; // reset for the new candle
        state.candleHistory.push(candle);
        state.lastOhlcTime = candle.time;
        if (state.candleHistory.length > CONFIG.MAX_CANDLE_HISTORY) {
            state.candleHistory.shift();
        }
    }

    if (state.currentMode === 'candle' && state.candleChart && state.historyLoaded) {
        try { state.candleChart.update(candle); } catch (_) { }
        updateCandleIndicators();
    }

    // Update candle timer
    const remaining = state.granularity - ((Math.floor(Date.now() / 1000)) % state.granularity);
    DOM.candleTimer.textContent = `${remaining}s`;
}

function handleCandleHistory(candles) {
    const formatted = candles.map(c => ({
        time: c.epoch,
        open: parseFloat(c.open),
        high: parseFloat(c.high),
        low: parseFloat(c.low),
        close: parseFloat(c.close),
    }));

    state.candleHistory = formatted;
    state.lastOhlcTime = formatted.length ? formatted[formatted.length - 1].time : 0;
    state.historyLoaded = true;   // history is ready — live updates may now use chart.update()

    if (state.currentMode === 'candle' && state.candleChart) {
        try { state.candleChart.setData(formatted); } catch (_) { }
        updateCandleIndicators();
    }
    setStatus(`Live data active — ${state.symbol}`, true);
}

// ═══════════════════════════════════════════════════════
//  CHART INITIALIZATION
// ═══════════════════════════════════════════════════════
function initCandleCharts() {
    // Destroy old charts
    if (state.candleChart) {
        try {
            state._candleTVChart.remove();
        } catch (_) { }
    }
    if (state.macdTVChart) {
        try { state.macdTVChart.remove(); } catch (_) { }
    }
    if (state.cciTVChart) {
        try { state.cciTVChart.remove(); } catch (_) { }
    }

    const baseOpts = {
        layout: {
            background: { type: 'solid', color: 'transparent' },
            textColor: COLORS.textMuted,
            fontFamily: 'Inter, sans-serif',
            fontSize: 10,
        },
        grid: {
            vertLines: { color: COLORS.gridLine },
            horzLines: { color: COLORS.gridLine },
        },
        crosshair: { mode: LightweightCharts.CrosshairMode.Normal },
        rightPriceScale: {
            borderColor: 'rgba(255,255,255,0.08)',
            scaleMargins: { top: 0.1, bottom: 0.1 },
        },
        timeScale: {
            borderColor: 'rgba(255,255,255,0.08)',
            timeVisible: true,
            secondsVisible: state.granularity <= 60,
        },
        handleScroll: true,
        handleScale: true,
    };

    // Main candle chart
    state._candleTVChart = LightweightCharts.createChart(DOM.candleContainer, {
        ...baseOpts,
        height: DOM.candleContainer.clientHeight || 300,
    });
    state.candleChart = state._candleTVChart.addCandlestickSeries({
        upColor: COLORS.green,
        downColor: COLORS.red,
        borderVisible: false,
        wickUpColor: COLORS.green,
        wickDownColor: COLORS.red,
    });

    // MA series
    state.maSeries = state._candleTVChart.addLineSeries({
        color: COLORS.gold,
        lineWidth: 1.5,
        title: `MA(${state.maPeriod})`,
        lastValueVisible: true,
        priceLineVisible: false,
    });

    // BB series
    state.bbUpperSeries = state._candleTVChart.addLineSeries({
        color: COLORS.bbUpper,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        title: 'BB Upper',
        lastValueVisible: false,
        priceLineVisible: false,
    });
    state.bbLowerSeries = state._candleTVChart.addLineSeries({
        color: COLORS.bbLower,
        lineWidth: 1,
        lineStyle: LightweightCharts.LineStyle.Dashed,
        title: 'BB Lower',
        lastValueVisible: false,
        priceLineVisible: false,
    });

    // MACD chart
    DOM.macdContainer.style.display = state.indicators.macd ? 'block' : 'none';
    state.macdTVChart = LightweightCharts.createChart(DOM.macdContainer, {
        ...baseOpts,
        height: 100,
        rightPriceScale: {
            ...baseOpts.rightPriceScale,
            scaleMargins: { top: 0.1, bottom: 0.1 },
        },
    });
    state.macdLineSeries = state.macdTVChart.addLineSeries({ color: COLORS.cyan, lineWidth: 1.5, title: 'MACD' });
    state.macdSignalSeries = state.macdTVChart.addLineSeries({ color: COLORS.orange, lineWidth: 1.5, title: 'Signal' });
    state.macdHistSeries = state.macdTVChart.addHistogramSeries({ title: 'Hist' });

    // CCI chart
    DOM.cciContainer.style.display = state.indicators.cci ? 'block' : 'none';
    state.cciTVChart = LightweightCharts.createChart(DOM.cciContainer, {
        ...baseOpts,
        height: 90,
    });
    state.cciLineSeries = state.cciTVChart.addLineSeries({ color: COLORS.purple, lineWidth: 1.5, title: 'CCI' });

    // Load existing data
    if (state.candleHistory.length) {
        state.candleChart.setData(state.candleHistory);
        updateCandleIndicators();
    }
}

function initLineChart() {
    if (state.lineChartInstance) {
        state.lineChartInstance.destroy();
    }

    const canvas = document.getElementById('line-chart-canvas');
    const ctx = canvas.getContext('2d');

    state.lineChartInstance = new Chart(ctx, {
        type: 'line',
        data: {
            labels: [],
            datasets: [
                {
                    label: 'Price',
                    data: [],
                    borderColor: COLORS.cyan,
                    borderWidth: 2,
                    pointRadius: 0,
                    tension: 0.3,
                    fill: {
                        target: 'origin',
                        above: 'rgba(0, 212, 255, 0.05)',
                    },
                    yAxisID: 'y',
                },
                {
                    label: `MA(${state.maPeriod})`,
                    data: [],
                    borderColor: COLORS.gold,
                    borderWidth: 1.5,
                    borderDash: [5, 5],
                    pointRadius: 0,
                    tension: 0.2,
                    fill: false,
                    yAxisID: 'y',
                    hidden: !state.indicators.ma,
                },
                {
                    label: 'BB Upper',
                    data: [],
                    borderColor: COLORS.bbUpper,
                    borderWidth: 1,
                    borderDash: [3, 3],
                    pointRadius: 0,
                    tension: 0.2,
                    fill: false,
                    yAxisID: 'y',
                    hidden: !state.indicators.bb,
                },
                {
                    label: 'BB Lower',
                    data: [],
                    borderColor: COLORS.bbLower,
                    borderWidth: 1,
                    borderDash: [3, 3],
                    pointRadius: 0,
                    tension: 0.2,
                    fill: false,
                    yAxisID: 'y',
                    hidden: !state.indicators.bb,
                },
            ],
        },
        options: {
            responsive: true,
            maintainAspectRatio: false,
            animation: false,
            interaction: { mode: 'index', intersect: false },
            plugins: {
                legend: {
                    display: true,
                    labels: { color: COLORS.textMuted, font: { size: 10 }, boxWidth: 12 },
                },
                tooltip: {
                    backgroundColor: 'rgba(10,15,30,0.9)',
                    borderColor: 'rgba(255,255,255,0.1)',
                    borderWidth: 1,
                    titleColor: '#fff',
                    bodyColor: COLORS.textMuted,
                },
            },
            scales: {
                x: {
                    display: false,
                    grid: { color: COLORS.gridLine },
                },
                y: {
                    grid: { color: COLORS.gridLine },
                    ticks: { color: COLORS.textMuted, font: { size: 10 }, maxTicksLimit: 6 },
                },
            },
        },
    });
}

// ═══════════════════════════════════════════════════════
//  TECHNICAL INDICATORS
// ═══════════════════════════════════════════════════════
function calcEMA(values, period) {
    if (!values || values.length < period) return [];
    const k = 2 / (period + 1);
    const result = new Array(values.length).fill(null);
    let sum = 0;
    for (let i = 0; i < period; i++) sum += values[i];
    result[period - 1] = sum / period;
    for (let i = period; i < values.length; i++) {
        result[i] = values[i] * k + result[i - 1] * (1 - k);
    }
    return result;
}

function calcSMA(values, period) {
    return values.map((_, i) => {
        if (i < period - 1) return null;
        const slice = values.slice(i - period + 1, i + 1);
        return slice.reduce((a, b) => a + b, 0) / period;
    });
}

function calcStdDev(values, period) {
    return values.map((_, i) => {
        if (i < period - 1) return null;
        const slice = values.slice(i - period + 1, i + 1);
        const mean = slice.reduce((a, b) => a + b, 0) / period;
        const variance = slice.reduce((a, b) => a + Math.pow(b - mean, 2), 0) / period;
        return Math.sqrt(variance);
    });
}

function calcBollingerBands(values, period = 20, mult = 2) {
    const sma = calcSMA(values, period);
    const std = calcStdDev(values, period);
    return {
        upper: sma.map((s, i) => s !== null && std[i] !== null ? s + mult * std[i] : null),
        middle: sma,
        lower: sma.map((s, i) => s !== null && std[i] !== null ? s - mult * std[i] : null),
    };
}

function calcMACD(values, fast = 12, slow = 26, signal = 9) {
    const emaFast = calcEMA(values, fast);
    const emaSlow = calcEMA(values, slow);
    const macdLine = values.map((_, i) =>
        emaFast[i] !== null && emaSlow[i] !== null ? emaFast[i] - emaSlow[i] : null
    );
    const validMacd = macdLine.filter(v => v !== null);
    const signalLine = calcEMA(validMacd, signal);

    let sigIdx = 0;
    const signalFull = macdLine.map(v => {
        if (v === null) return null;
        return signalLine[sigIdx++] ?? null;
    });
    const histogram = macdLine.map((m, i) =>
        m !== null && signalFull[i] !== null ? m - signalFull[i] : null
    );

    return { macdLine, signalLine: signalFull, histogram };
}

function calcCCI(candles, period = 20) {
    return candles.map((_, i) => {
        if (i < period - 1) return null;
        const slice = candles.slice(i - period + 1, i + 1);
        const tp = slice.map(c => (c.high + c.low + c.close) / 3);
        const sma = tp.reduce((a, b) => a + b, 0) / period;
        const md = tp.reduce((a, b) => a + Math.abs(b - sma), 0) / period;
        return md === 0 ? 0 : (tp[tp.length - 1] - sma) / (0.015 * md);
    });
}

function updateCandleIndicators() {
    if (!state.candleHistory.length || !state._candleTVChart) return;

    const closes = state.candleHistory.map(c => c.close);
    const times = state.candleHistory.map(c => c.time);

    // MA
    const ma = calcSMA(closes, state.maPeriod);
    const maData = times.map((t, i) => ma[i] !== null ? { time: t, value: ma[i] } : null).filter(Boolean);
    if (state.indicators.ma && state.maSeries) {
        try { state.maSeries.setData(maData); } catch (_) { }
    } else if (state.maSeries) {
        try { state.maSeries.setData([]); } catch (_) { }
    }

    // BB
    const bb = calcBollingerBands(closes, state.maPeriod);
    const bbUpper = times.map((t, i) => bb.upper[i] !== null ? { time: t, value: bb.upper[i] } : null).filter(Boolean);
    const bbLower = times.map((t, i) => bb.lower[i] !== null ? { time: t, value: bb.lower[i] } : null).filter(Boolean);
    if (state.indicators.bb) {
        try { state.bbUpperSeries.setData(bbUpper); state.bbLowerSeries.setData(bbLower); } catch (_) { }
    } else {
        try { state.bbUpperSeries.setData([]); state.bbLowerSeries.setData([]); } catch (_) { }
    }

    // MACD
    if (state.indicators.macd && state.macdLineSeries) {
        try {
            const macd = calcMACD(closes);
            const macdData = times.map((t, i) => macd.macdLine[i] !== null ? { time: t, value: macd.macdLine[i] } : null).filter(Boolean);
            const signalData = times.map((t, i) => macd.signalLine[i] !== null ? { time: t, value: macd.signalLine[i] } : null).filter(Boolean);
            const histData = times.map((t, i) => macd.histogram[i] !== null ? {
                time: t, value: macd.histogram[i],
                color: macd.histogram[i] >= 0 ? 'rgba(34,211,164,0.6)' : 'rgba(245,59,92,0.6)',
            } : null).filter(Boolean);
            state.macdLineSeries.setData(macdData);
            state.macdSignalSeries.setData(signalData);
            state.macdHistSeries.setData(histData);
        } catch (_) { }
    }

    // CCI
    if (state.indicators.cci && state.cciLineSeries) {
        try {
            const cci = calcCCI(state.candleHistory);
            const cciData = times.map((t, i) => cci[i] !== null ? {
                time: t, value: cci[i],
                color: cci[i] > 100 ? COLORS.green : cci[i] < -100 ? COLORS.red : COLORS.purple,
            } : null).filter(Boolean);
            state.cciLineSeries.setData(cciData);
        } catch (_) { }
    }
}

// ═══════════════════════════════════════════════════════
//  LINE CHART + DIGIT BARS
// ═══════════════════════════════════════════════════════
function updateLineChart() {
    if (!state.lineChartInstance || state.currentMode !== 'line') return;

    const recent = state.priceHistory.slice(-CONFIG.LINE_CHART_POINTS);
    const prices = recent.map(p => p.price);
    const labels = recent.map((_, i) => i);
    const ma = calcSMA(prices, Math.min(state.maPeriod, prices.length));
    const bb = calcBollingerBands(prices, Math.min(state.maPeriod, prices.length));

    const chart = state.lineChartInstance;
    chart.data.labels = labels;
    chart.data.datasets[0].data = prices;
    chart.data.datasets[1].data = ma;
    chart.data.datasets[1].hidden = !state.indicators.ma;
    chart.data.datasets[2].data = bb.upper;
    chart.data.datasets[2].hidden = !state.indicators.bb;
    chart.data.datasets[3].data = bb.lower;
    chart.data.datasets[3].hidden = !state.indicators.bb;
    chart.update('none');
}

function buildDistBars() {
    DOM.digitDistBars.innerHTML = '';
    for (let i = 0; i <= 9; i++) {
        const col = document.createElement('div');
        col.className = 'dist-col';
        col.innerHTML = `
            <div class="dist-bar-wrap">
                <div class="dist-bar-fill" id="dbfill-${i}" style="height:0%"></div>
                <div class="dist-pct-label" id="dpct-${i}">0%</div>
            </div>
            <div class="dist-digit-label">${i}</div>
            <div class="dist-count-label" id="dcnt-${i}">0</div>
        `;
        DOM.digitDistBars.appendChild(col);
    }
}

function updateDistBars() {
    const total = state.tickHistory.length;
    if (!total) return;
    const maxCount = Math.max(...state.digitCounts, 1);
    const minCount = Math.min(...state.digitCounts);

    for (let i = 0; i <= 9; i++) {
        const cnt = state.digitCounts[i];
        const pct = (cnt / total * 100);
        const h = (cnt / maxCount * 100);
        const fill = document.getElementById(`dbfill-${i}`);
        const pctEl = document.getElementById(`dpct-${i}`);
        const cntEl = document.getElementById(`dcnt-${i}`);
        if (!fill) continue;

        fill.style.height = h + '%';
        pctEl.textContent = pct.toFixed(1) + '%';
        cntEl.textContent = cnt;

        fill.className = 'dist-bar-fill';
        if (cnt === maxCount && cnt > 0) fill.classList.add('bar-highest');
        else if (cnt === minCount && total > 20) fill.classList.add('bar-lowest');
    }
}

// ═══════════════════════════════════════════════════════
//  UI UPDATE FUNCTIONS
// ═══════════════════════════════════════════════════════
function addDigitToStream(digit) {
    const node = document.createElement('div');
    node.className = `stream-node ${digit % 2 === 0 ? 'stream-even' : 'stream-odd'}`;
    node.textContent = digit;
    node.style.animationDelay = '0ms';
    DOM.digitStream.insertBefore(node, DOM.digitStream.firstChild);
    const children = DOM.digitStream.children;
    while (children.length > 30) {
        DOM.digitStream.removeChild(DOM.digitStream.lastChild);
    }
}

function animateDigitRing(digit) {
    DOM.digitRing.style.color = digit % 2 === 0 ? COLORS.purple : COLORS.cyan;
    DOM.digitRing.style.boxShadow = `0 0 20px ${digit % 2 === 0 ? COLORS.purple : COLORS.cyan}60`;
    DOM.digitRing.style.borderColor = digit % 2 === 0 ? COLORS.purple : COLORS.cyan;
}

function updateTickCounter() {
    DOM.tickCounter.textContent = state.tickCount;
    if (DOM.sampleTicksBadge) DOM.sampleTicksBadge.textContent = state.tickHistory.length;
    DOM.sampleInfo.textContent = `${state.tickHistory.length} ticks`;
}


function updateFlowStats() {
    const history = state.tickHistory.slice(-state.sampleSize);
    const total = history.length;
    if (!total) return;

    let odd = 0, even = 0, over = 0, under = 0;
    history.forEach(d => {
        if (d % 2 === 0) even++; else odd++;
        if (d > 4) over++; else under++;
    });

    const pct = v => (v / total * 100);
    const fmt = v => pct(v).toFixed(1) + '%';

    DOM.statOdd.textContent = fmt(odd);
    DOM.barOdd.style.width = pct(odd) + '%';
    DOM.statEven.textContent = fmt(even);
    DOM.barEven.style.width = pct(even) + '%';
    DOM.statOver.textContent = fmt(over);
    DOM.barOver.style.width = pct(over) + '%';
    DOM.statUnder.textContent = fmt(under);
    DOM.barUnder.style.width = pct(under) + '%';
}

function buildFreqTable() {
    if (!DOM.freqTable) return;
    for (let i = 0; i <= 9; i++) {
        const row = document.createElement('div');
        row.className = 'freq-row';
        row.id = `freq-row-${i}`;
        row.innerHTML = `
            <span class="freq-digit">${i}</span>
            <div class="freq-bar-bg"><div class="freq-fill" id="fq-bar-${i}" style="width:0%"></div></div>
            <span class="freq-pct" id="fq-pct-${i}">0%</span>
            <span class="freq-count" id="fq-cnt-${i}">0</span>
        `;
        DOM.freqTable.appendChild(row);
    }
}

function updateFreqTable() {
    if (!DOM.freqTable) return;
    const total = state.tickHistory.length;
    if (!total) return;
    const maxCount = Math.max(...state.digitCounts, 1);
    const minCount = Math.min(...state.digitCounts);

    for (let i = 0; i <= 9; i++) {
        const cnt = state.digitCounts[i];
        const pct = (cnt / total * 100);
        const barEl = document.getElementById(`fq-bar-${i}`);
        const pctEl = document.getElementById(`fq-pct-${i}`);
        const cntEl = document.getElementById(`fq-cnt-${i}`);
        const rowEl = document.getElementById(`freq-row-${i}`);
        if (!barEl) continue;

        barEl.style.width = (cnt / maxCount * 100) + '%';
        pctEl.textContent = pct.toFixed(1) + '%';
        cntEl.textContent = cnt;

        rowEl.className = 'freq-row';
        if (cnt === maxCount && cnt > 0) { barEl.className = 'freq-fill fill-high'; rowEl.classList.add('row-high'); }
        else if (cnt === minCount && total > 20) { barEl.className = 'freq-fill fill-low'; rowEl.classList.add('row-low'); }
        else barEl.className = 'freq-fill fill-normal';
    }
}


function updateBotSignal() {
    const history = state.tickHistory.slice(-state.sampleSize);
    const total = history.length;
    if (total < 20) {
        DOM.botStatus.textContent = `Collecting... ${total}/20`;
        DOM.signalMain.textContent = 'WAITING';
        DOM.signalSub.textContent = `Need ${20 - total} more ticks`;
        return;
    }

    DOM.botStatus.textContent = 'Live & Analyzing';

    const sorted = state.digitCounts
        .map((c, d) => ({ d, c }))
        .sort((a, b) => b.c - a.c);
    const hot = sorted.slice(0, 3);
    const cold = sorted.slice(-3).reverse();

    // Render hot/cold tags
    DOM.hotTags.innerHTML = hot.map(x =>
        `<span class="digit-tag hot-tag">${x.d}</span>`
    ).join('');
    DOM.coldTags.innerHTML = cold.map(x =>
        `<span class="digit-tag cold-tag">${x.d}</span>`
    ).join('');

    let odd = 0, even = 0, over = 0, under = 0;
    history.forEach(d => {
        if (d % 2 === 0) even++; else odd++;
        if (d > 4) over++; else under++;
    });
    const oddPct = odd / total * 100;
    const evenPct = even / total * 100;
    const overPct = over / total * 100;
    const underPct = under / total * 100;

    const last = state.tickHistory.slice(-6);
    const streakOdd = (last.length >= 6) && last.every(d => d % 2 !== 0);
    const streakEven = (last.length >= 6) && last.every(d => d % 2 === 0);
    const streakOver = (last.length >= 6) && last.every(d => d > 4);
    const streakUnder = (last.length >= 6) && last.every(d => d <= 4);

    let streakLabel = 'None';
    if (streakOdd) streakLabel = `6x ODD 🔥`;
    else if (streakEven) streakLabel = `6x EVEN 🔥`;
    else if (streakOver) streakLabel = `6x OVER 🔥`;
    else if (streakUnder) streakLabel = `6x UNDER 🔥`;
    DOM.signalStreak.textContent = streakLabel;

    // --- ML INTEGRATION ---
    const ml = computeMLSignal();
    const mlState = state.mlModel;

    // Update ML Meta UI
    document.getElementById('ml-ticks').textContent = `${mlState.totalTicks} ticks`;
    document.getElementById('ml-regime').textContent = mlState.regime.toUpperCase();
    document.getElementById('ml-factors').textContent = ml.factors.join(', ') || 'None';

    // Logic: ML + Reversal Logic
    let action = 'NEUTRAL', sub = 'Collecting data...', conf = 50, type = 'neutral';

    if (streakOdd) {
        action = 'BET EVEN'; sub = 'ODD streak reversal expected'; conf = 75; type = 'alert';
    } else if (streakEven) {
        action = 'BET ODD'; sub = 'EVEN streak reversal expected'; conf = 75; type = 'alert';
    } else if (streakOver) {
        action = 'BET UNDER'; sub = 'OVER streak reversal expected'; conf = 72; type = 'alert';
    } else if (streakUnder) {
        action = 'BET OVER'; sub = 'UNDER streak reversal expected'; conf = 72; type = 'alert';
    } else if (ml.direction !== 'neutral') {
        action = ml.direction === 'rise' ? 'BET OVER' : 'BET UNDER';
        sub = `AI Consensus: ${ml.factors[0] || 'Learning'}`;
        conf = ml.strength;
        type = ml.strength > 40 ? 'active' : 'neutral';
    } else if (oddPct > 60) {
        action = 'BET ODD'; sub = `Odd heavy: ${oddPct.toFixed(1)}%`; conf = oddPct; type = 'active';
    } else if (evenPct > 60) {
        action = 'BET EVEN'; sub = `Even heavy: ${evenPct.toFixed(1)}%`; conf = evenPct; type = 'active';
    }

    DOM.signalMain.textContent = action;
    DOM.signalSub.textContent = sub;
    DOM.signalConf.textContent = conf.toFixed(1) + '%';
    DOM.signalCard.className = `glass-card signal-card signal-${type}`;
}

function updateSpeedMetrics(now) {
    const oneMinAgo = now - 60000;
    state.tickTimestamps = state.tickTimestamps.filter(t => t > oneMinAgo);
    DOM.ticksPerMin.textContent = state.tickTimestamps.length;

    if (state.lastTickTime) {
        const elapsed = ((now - state.lastTickTime) / 1000).toFixed(1);
        DOM.lastTickTime.textContent = elapsed + 's ago';
    }

    // Approximate volatility from price changes
    if (state.priceHistory.length >= 10) {
        const recent = state.priceHistory.slice(-10).map(p => p.price);
        const changes = recent.slice(1).map((p, i) => Math.abs(p - recent[i]));
        const avgChange = changes.reduce((a, b) => a + b, 0) / changes.length;
        DOM.marketVol.textContent = avgChange.toFixed(4);
    }
}

/**
 * Core Online Learning function. Updates Markov probabilities, EWMA stats, 
 * and evaluates previous predictions for accuracy tracking.
 */
function updateMLModel(digit) {
    const ml = state.mlModel;
    const prevDigit = ml.lastDigit;

    // 1. Evaluate previous predictions (Accuracy tracking)
    if (ml.predictions.nextDigit !== null) {
        const dAcc = (digit === ml.predictions.nextDigit) ? 1 : 0;
        ml.accuracy.digit.push(dAcc);
        if (ml.accuracy.digit.length > 100) ml.accuracy.digit.shift();
    }
    if (ml.predictions.nextOU !== null) {
        const curOU = (digit > 4) ? 'over' : 'under';
        const ouAcc = (curOU === ml.predictions.nextOU) ? 1 : 0;
        ml.accuracy.ou.push(ouAcc);
        if (ml.accuracy.ou.length > 100) ml.accuracy.ou.shift();
    }
    if (ml.predictions.nextOE !== null) {
        const curOE = (digit % 2 === 0) ? 'even' : 'odd';
        const oeAcc = (curOE === ml.predictions.nextOE) ? 1 : 0;
        ml.accuracy.oe.push(oeAcc);
        if (ml.accuracy.oe.length > 100) ml.accuracy.oe.shift();
    }

    // 2. Update Statistics
    ml.totalTicks++;
    if (prevDigit !== null) {
        // Markov update
        ml.markov[prevDigit][digit]++;
        // N-gram update
        const key = `${prevDigit}-${digit}`;
        ml.ngram2[key] = (ml.ngram2[key] || 0) + 1;
    }

    // EWMA update
    const alpha = ml.ewm.alpha;
    for (let i = 0; i < 10; i++) {
        const hit = (i === digit) ? 100 : 0;
        ml.ewm.digits[i] = (1 - alpha) * ml.ewm.digits[i] + alpha * hit;
    }

    const curIsEven = (digit % 2 === 0);
    ml.ewm.even = (1 - alpha) * ml.ewm.even + alpha * (curIsEven ? 100 : 0);
    ml.ewm.odd = (1 - alpha) * ml.ewm.odd + alpha * (!curIsEven ? 100 : 0);

    const curIsOver = (digit > 4);
    ml.ewm.over = (1 - alpha) * ml.ewm.over + alpha * (curIsOver ? 100 : 0);
    ml.ewm.under = (1 - alpha) * ml.ewm.under + alpha * (!curIsOver ? 100 : 0);

    // 3. Generate Next Predictions for tracking
    // Markov-based next digit: pick digit with highest transition count from current
    let maxTrans = -1;
    let predictedDigit = null;
    for (let i = 0; i < 10; i++) {
        if (ml.markov[digit][i] > maxTrans) {
            maxTrans = ml.markov[digit][i];
            predictedDigit = i;
        }
    }
    ml.predictions.nextDigit = predictedDigit;
    ml.predictions.nextOE = ml.ewm.even > ml.ewm.odd ? 'even' : 'odd';
    ml.predictions.nextOU = ml.ewm.over > ml.ewm.under ? 'over' : 'under';

    // 4. Update Regime
    if (state.tickHistory.length > 20) {
        const last5 = state.tickHistory.slice(-5);
        const unique = new Set(last5).size;
        if (unique <= 2) ml.regime = 'trending'; // frequent repeats or oscillation
        else if (unique >= 4) ml.regime = 'volatile';
        else ml.regime = 'neutral';
    }

    ml.lastDigit = digit;
}

/**
 * Computes a weighted consensus signal from multiple ML factors.
 * Returns { direction: 'rise'|'fall'|'neutral', strength: 0-100, factors: [] }
 */
function computeMLSignal() {
    const ml = state.mlModel;
    if (ml.totalTicks < 50) return { direction: 'neutral', strength: 0, factors: ['learning...'] };

    let score = 0; // Negative for Under/Even bias, Positive for Over/Odd bias
    const factors = [];

    // Factor 1: EWMA Bias
    const oeDiff = ml.ewm.odd - ml.ewm.even;
    if (Math.abs(oeDiff) > 15) {
        score += oeDiff * 0.5;
        factors.push(oeDiff > 0 ? 'Odd-Skew' : 'Even-Skew');
    }

    const ouDiff = ml.ewm.over - ml.ewm.under;
    if (Math.abs(ouDiff) > 15) {
        score += ouDiff * 0.8;
        factors.push(ouDiff > 0 ? 'Over-Skew' : 'Under-Skew');
    }

    // Factor 2: Markov Predictability
    if (ml.lastDigit !== null) {
        const transitions = ml.markov[ml.lastDigit];
        const sum = transitions.reduce((a, b) => a + b, 0);
        if (sum > 10) {
            let maxIdx = 0;
            for (let i = 1; i < 10; i++) if (transitions[i] > transitions[maxIdx]) maxIdx = i;
            const prob = transitions[maxIdx] / sum;
            if (prob > 0.25) { // 0.1 is random
                const weight = (prob - 0.1) * 200;
                const isOver = maxIdx > 4;
                score += isOver ? weight : -weight;
                factors.push('Markov-Repeat');
            }
        }
    }

    // Normalize signal
    const strength = Math.min(Math.abs(score), 100);
    const direction = score > 10 ? 'rise' : (score < -10 ? 'fall' : 'neutral');

    return { direction, strength, factors };
}

function updatePatterns() {
    if (state.tickHistory.length < 10) return;
    const patterns = [];
    const last = state.tickHistory.slice(-10);

    // Alternating pattern
    let alt = true;
    for (let i = 1; i < last.length; i++) {
        if ((last[i] % 2) === (last[i - 1] % 2)) { alt = false; break; }
    }
    if (alt) patterns.push({ label: 'Alternating ODD/EVEN', strength: 'strong', color: 'cyan' });

    // Consecutive same
    const last3 = last.slice(-3);
    if (last3.every(d => d % 2 === 0)) patterns.push({ label: '3x EVEN streak', strength: 'medium', color: 'purple' });
    if (last3.every(d => d % 2 !== 0)) patterns.push({ label: '3x ODD streak', strength: 'medium', color: 'orange' });
    if (last3.every(d => d > 4)) patterns.push({ label: '3x OVER streak', strength: 'medium', color: 'green' });
    if (last3.every(d => d <= 4)) patterns.push({ label: '3x UNDER streak', strength: 'medium', color: 'red' });

    // Same digit
    if (last3[0] === last3[1] && last3[1] === last3[2]) {
        patterns.push({ label: `Repeated digit ${last3[0]}`, strength: 'rare', color: 'gold' });
    }

    if (patterns.length === 0) patterns.push({ label: 'No clear pattern', strength: 'info', color: 'muted' });

    DOM.patternList.innerHTML = patterns.map(p =>
        `<div class="pattern-item pattern-${p.strength} text-${p.color}">
            <span class="pattern-dot"></span>
            ${p.label}
            <span class="pattern-strength-badge">${p.strength}</span>
        </div>`
    ).join('');
}

function updateTradeRecs() {
    const total = state.tickHistory.length;
    if (total < 20) return;

    const sorted = state.digitCounts.map((c, d) => ({ d, c })).sort((a, b) => b.c - a.c);
    const bestDigit = sorted[0];
    const worstDigit = sorted[sorted.length - 1];

    let odd = 0, even = 0, over = 0, under = 0;
    state.tickHistory.forEach(d => {
        if (d % 2 === 0) even++; else odd++;
        if (d > 4) over++; else under++;
    });

    const fmt = (label, pct, type) => `<span class="rec-label">${label}</span><span class="rec-pct text-${type}">${pct.toFixed(1)}%</span>`;

    DOM.recDigits.innerHTML = `Match <strong>${bestDigit.d}</strong> · Differ <strong>${worstDigit.d}</strong>`;
    DOM.recOE.innerHTML = fmt(odd > even ? 'ODD' : 'EVEN', Math.max(odd, even) / total * 100, odd > even ? 'cyan' : 'purple');
    DOM.recOU.innerHTML = fmt(over > under ? 'OVER 4' : 'UNDER 5', Math.max(over, under) / total * 100, over > under ? 'green' : 'red');
    DOM.recMD.innerHTML = `Match <strong>${bestDigit.d}</strong> — Rate: ${(bestDigit.c / total * 100).toFixed(1)}%`;

    // ML Accuracy Display
    const ml = state.mlModel;
    const calcAcc = (arr) => arr.length ? (arr.reduce((a, b) => a + b, 0) / arr.length * 100).toFixed(1) : '0.0';

    const oeAcc = calcAcc(ml.accuracy.oe);
    const ouAcc = calcAcc(ml.accuracy.ou);
    const totalAcc = ((parseFloat(oeAcc) + parseFloat(ouAcc)) / 2).toFixed(1);

    document.getElementById('ml-oe-acc').textContent = `${oeAcc}%`;
    document.getElementById('ml-ou-acc').textContent = `${ouAcc}%`;
    document.getElementById('ml-total-acc').textContent = `${totalAcc}%`;
}

// ═══════════════════════════════════════════════════════
//  DIGIT-CANDLE CORRELATION REPORT
// ═══════════════════════════════════════════════════════

/**
 * Called once per closed candle. Accumulates all digits seen during
 * that candle and stores Over-5 / Under-4 counts by color × MA zone.
 */
function recordCandleDigit(closedCandle) {
    const digits = state.currentCandleDigits;
    if (!digits.length) return;

    // Candle color: green if close >= open
    const color = closedCandle.close >= closedCandle.open ? 'green' : 'red';

    // Position relative to MA (above_ma / below_ma)
    let zone = 'above_ma';
    const history = state.candleHistory;
    if (history.length >= state.maPeriod) {
        const closes = history.map(c => c.close);
        const ma = calcSMA(closes, state.maPeriod);
        const maVal = ma[closes.length - 1];
        if (maVal !== null) {
            zone = closedCandle.close >= maVal ? 'above_ma' : 'below_ma';
        }
    }

    const over4 = digits.filter(d => d > 4).length;
    const under5 = digits.filter(d => d < 5).length;

    state.candleDigitLog.push({ color, zone, over4, under5, total: digits.length });
    if (state.candleDigitLog.length > 300) state.candleDigitLog.shift();

    updateCandleDigitReport();
}

/**
 * Renders the focused Over-5 / Under-4 counts broken down by
 * candle color (green / red) × MA position (above / below).
 */
function updateCandleDigitReport() {
    const log = state.candleDigitLog;
    const total = log.length;

    const sampleEl = document.getElementById('report-sample-count');
    if (sampleEl) sampleEl.textContent = `${total} candle${total !== 1 ? 's' : ''}`;

    const tableEl = document.getElementById('dcr-table-body');
    if (!tableEl) return;

    if (!total) {
        tableEl.innerHTML = '<div class="dcr-empty">Waiting for candle data...</div>';
        return;
    }

    const rows = [
        { label: '🔴 Red', sub: 'Below MA', color: 'red', zone: 'below_ma', cls: 'dcr-red-below' },
        { label: '🔴 Red', sub: 'Above MA', color: 'red', zone: 'above_ma', cls: 'dcr-red-above' },
        { label: '🟢 Green', sub: 'Below MA', color: 'green', zone: 'below_ma', cls: 'dcr-grn-below' },
        { label: '🟢 Green', sub: 'Above MA', color: 'green', zone: 'above_ma', cls: 'dcr-grn-above' },
    ];

    tableEl.innerHTML = rows.map(r => {
        const entries = log.filter(e => e.color === r.color && e.zone === r.zone);
        const candles = entries.length;
        const totalTicks = entries.reduce((s, e) => s + e.total, 0);
        const over4 = entries.reduce((s, e) => s + (e.over4 || 0), 0);
        const under5 = entries.reduce((s, e) => s + (e.under5 || 0), 0);
        const o4Pct = totalTicks > 0 ? (over4 / totalTicks * 100) : 0;
        const u5Pct = totalTicks > 0 ? (under5 / totalTicks * 100) : 0;

        return `<div class="dcr-stat-row ${r.cls}">
            <div class="dcr-stat-header">
                <span class="dcr-stat-label">${r.label} <span class="dcr-stat-sub">${r.sub}</span></span>
                <span class="dcr-stat-meta">${candles} candles · ${totalTicks} ticks</span>
            </div>
            <div class="dcr-stat-grid">
                <div class="dcr-stat-cell dcr-over">
                    <div class="dcr-cell-main">
                        <span class="dcr-cell-count">${over4}</span>
                        <span class="dcr-cell-pct">${o4Pct.toFixed(1)}%</span>
                    </div>
                    <div class="dcr-cell-key">Over 4</div>
                    <div class="dcr-mini-bar-bg"><div class="dcr-mini-bar dcr-bar-over" style="width:${Math.min(o4Pct, 100).toFixed(0)}%"></div></div>
                </div>
                <div class="dcr-stat-cell dcr-under">
                    <div class="dcr-cell-main">
                        <span class="dcr-cell-count">${under5}</span>
                        <span class="dcr-cell-pct">${u5Pct.toFixed(1)}%</span>
                    </div>
                    <div class="dcr-cell-key">Under 5</div>
                    <div class="dcr-mini-bar-bg"><div class="dcr-mini-bar dcr-bar-under" style="width:${Math.min(u5Pct, 100).toFixed(0)}%"></div></div>
                </div>
            </div>
        </div>`;
    }).join('');
}


// ═══════════════════════════════════════════════════════
//  HELPERS
// ═══════════════════════════════════════════════════════
function setConnected(connected) {
    DOM.connRing.className = `connection-ring ${connected ? 'connected' : ''}`;
    DOM.connLabel.textContent = connected ? `Live: ${state.symbol}` : 'Disconnected';
    DOM.wsIndicator.className = `status-dot ${connected ? 'dot-green' : 'dot-red'}`;
    DOM.wsStatusText.textContent = connected ? 'Connected' : 'Disconnected';
}

function setStatus(msg, good) {
    DOM.statusMsg.textContent = msg;
    DOM.statusMsg.style.color = good ? COLORS.green : COLORS.orange;
}

// ═══════════════════════════════════════════════════════
//  EVENT LISTENERS
// ═══════════════════════════════════════════════════════
$('market-selector').addEventListener('change', e => {
    const symbol = e.target.value;
    const url = new URL(window.location.href);
    url.searchParams.set('symbol', symbol);
    window.open(url.toString(), '_blank');

    // Reset selector to current tab's symbol so it doesn't look like we switched here
    e.target.value = state.symbol;
});

$('granularity-select').addEventListener('change', e => {
    state.granularity = parseInt(e.target.value);
    subscribeSymbol(state.symbol);
});

$('ma-period-select').addEventListener('change', e => {
    state.maPeriod = parseInt(e.target.value);
    updateCandleIndicators();
    if (state.lineChartInstance) {
        state.lineChartInstance.data.datasets[1].label = `MA(${state.maPeriod})`;
        updateLineChart();
    }
});

$('sample-size').addEventListener('change', e => {
    state.sampleSize = parseInt(e.target.value);
    updateFlowStats();
    updateBotSignal();
});

// Chart mode tabs
document.querySelectorAll('.mode-tab').forEach(btn => {
    btn.addEventListener('click', () => {
        document.querySelectorAll('.mode-tab').forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        state.currentMode = btn.dataset.mode;
        DOM.candlePanel.classList.toggle('hidden', state.currentMode !== 'candle');
        DOM.linePanel.classList.toggle('hidden', state.currentMode !== 'line');
        DOM.botPanel.classList.toggle('hidden', state.currentMode !== 'bot');
        DOM.indicatorPanel.style.display = (state.currentMode === 'bot') ? 'none' : 'flex';

        if (state.currentMode === 'line') {
            initLineChart();
            updateLineChart();
            updateDistBars();
        } else if (state.currentMode === 'candle') {
            // Reinit candle charts to fix sizing after hidden
            setTimeout(() => {
                initCandleCharts();
            }, 50);
        }
    });
});

// Indicator toggle buttons
document.querySelectorAll('.ind-btn').forEach(btn => {
    btn.addEventListener('click', () => {
        const ind = btn.dataset.ind;
        state.indicators[ind] = !state.indicators[ind];
        btn.classList.toggle('active', state.indicators[ind]);

        if (state.currentMode === 'candle') {
            // Show/hide MACD and CCI subcharts
            if (ind === 'macd') {
                DOM.macdContainer.style.display = state.indicators.macd ? 'block' : 'none';
                if (state.indicators.macd && state.macdTVChart) {
                    try { state.macdTVChart.applyOptions({ height: 100 }); } catch (_) { }
                }
            }
            if (ind === 'cci') {
                DOM.cciContainer.style.display = state.indicators.cci ? 'block' : 'none';
            }
            updateCandleIndicators();
        } else {
            updateLineChart();
        }
    });
});

// Window resize — sync chart sizes
window.addEventListener('resize', () => {
    if (state._candleTVChart) {
        try {
            state._candleTVChart.applyOptions({ width: DOM.candleContainer.clientWidth });
        } catch (_) { }
    }
});

// ═══════════════════════════════════════════════════════
//  STARTUP
// ═══════════════════════════════════════════════════════
function init() {
    buildDistBars();
    buildFreqTable();
    initCandleCharts();

    // 1. Handle OAuth redirect tokens if present
    const urlParams = new URLSearchParams(window.location.search);
    const token1 = urlParams.get('token1');
    if (token1) {
        state.apiToken = token1;
        localStorage.setItem('deriv_api_token', token1);
        // Clean up URL
        const cleanUrl = window.location.protocol + "//" + window.location.host + window.location.pathname;
        window.history.replaceState({ path: cleanUrl }, '', cleanUrl);
        setStatus('Logged in via Live Login', true);
    } else {
        // 2. Check for saved API token
        const savedToken = localStorage.getItem('deriv_api_token');
        if (savedToken) {
            state.apiToken = savedToken;
        }
    }

    // 3. URL Parameter Detection: ?symbol=...
    const symParam = urlParams.get('symbol');
    if (symParam) {
        state.symbol = symParam;
        const selector = $('market-selector');
        if (selector) selector.value = symParam;
    }

    connectWS();
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}

// ═══════════════════════════════════════════════════════
//  AUTH — DERIV API TOKEN LOGIN
// ═══════════════════════════════════════════════════════

function handleAuthorize(auth) {
    if (!auth || auth.error) {
        showLoginError('Invalid token. Please check your API token and try again.');
        resetConnectBtn();
        return;
    }

    state.accountInfo = auth;
    state.accountList = auth.account_list || [];

    // Only update apiToken from the modal input if it actually has a value.
    // During account switching the modal is closed and its value is empty �
    // the correct token was already placed in state.apiToken by switchAccount().
    const inputToken = $('api-token-input') ? $('api-token-input').value.trim() : '';
    if (inputToken) state.apiToken = inputToken;

    // Save the active token
    if (state.apiToken) localStorage.setItem('deriv_api_token', state.apiToken);

    // Update UI
    renderAccountInfo(auth);
    renderAccountSwitcher();
    closeLoginModal();
    resetConnectBtn();

    // Cancel any existing balance subscription then start fresh for this account
    wsSend({ forget_all: 'balance' });
    wsSend({ balance: 1, subscribe: 1 });

    setStatus(`Authorized as ${auth.fullname || auth.loginid} (${auth.loginid})`, true);
}

function handleBalance(bal) {
    if (!bal) return;
    const balEl = $('acct-balance');
    if (balEl) {
        balEl.textContent = parseFloat(bal.balance).toFixed(2);
    }
    const currEl = $('acct-currency');
    if (currEl && bal.currency) {
        currEl.textContent = bal.currency;
    }
}

function renderAccountInfo(auth) {
    const bar = $('account-info-bar');
    const loginBtn = $('login-btn');
    if (!bar) return;

    const isDemo = auth.is_virtual || (auth.loginid && auth.loginid.startsWith('VR'));
    const typeLabel = isDemo ? '?? Demo' : '?? Real';
    const typeEl = $('acct-type');
    if (typeEl) typeEl.textContent = typeLabel;

    $('acct-loginid').textContent = auth.loginid || '--';
    $('acct-balance').textContent = auth.balance !== undefined ? parseFloat(auth.balance).toFixed(2) : '--';
    $('acct-currency').textContent = auth.currency || '--';
    $('acct-name').textContent = auth.fullname || auth.email || '--';

    bar.style.display = 'flex';
    if (loginBtn) loginBtn.style.display = 'none';
}

function renderAccountSwitcher() {
    const container = $('acct-switcher');
    if (!container) return;
    const accounts = state.accountList;
    if (!accounts || accounts.length < 2) {
        container.style.display = 'none';
        return;
    }
    container.style.display = 'flex';
    container.innerHTML = accounts.map(acct => {
        const isDemo = acct.is_virtual || (acct.loginid && acct.loginid.startsWith('VR'));
        const label = isDemo ? 'Demo' : 'Real';
        const isCurrent = acct.loginid === (state.accountInfo && state.accountInfo.loginid);
        return `<button
            class="acct-switch-btn ${isDemo ? 'switch-demo' : 'switch-real'} ${isCurrent ? 'switch-active' : ''}"
            onclick="switchAccount('${acct.token}', '${acct.loginid}')"
            title="${acct.loginid} (${acct.currency || ''})"
        >${label}<span class="switch-id">${acct.loginid}</span></button>`;
    }).join('');
}

window.switchAccount = function (token, loginid) {
    if (!token) return;
    // Avoid redundant switch
    if (state.accountInfo && state.accountInfo.loginid === loginid) return;
    setStatus('Switching to ' + loginid + '...', true);
    // Set token BEFORE wsSend so handleAuthorize does not overwrite it
    // with the empty modal input value.
    state.apiToken = token;
    localStorage.setItem('deriv_api_token', token);
    wsSend({ authorize: token });
};


function authorizeWS() {
    if (state.apiToken && state.ws && state.ws.readyState === WebSocket.OPEN) {
        wsSend({ authorize: state.apiToken });
    }
}

// Extend onopen to authorize
const _origConnectWS = connectWS;
// Override ws.onopen after connectWS to also send authorize
function onWSOpen_auth() {
    if (state.apiToken) {
        authorizeWS();
    }
}

// Patch the connectWS function's onopen (done by re-assigning after connection)
const _origWsSend = wsSend;
function patchWSOpen() {
    if (state.ws) {
        const origOnOpen = state.ws.onopen;
        state.ws.onopen = (e) => {
            if (origOnOpen) origOnOpen(e);
            if (state.apiToken) authorizeWS();
        };
    }
}

// ═══════════════════════════════════════════════════════
//  OAUTH LOGIN
// ═══════════════════════════════════════════════════════
window.loginViaOAuth = function () {
    window.location.href = CONFIG.OAUTH_URL;
};

// ═══════════════════════════════════════════════════════
//  LOGIN MODAL FUNCTIONS (global scope for onclick)
// ═══════════════════════════════════════════════════════

window.openLoginModal = function () {
    const modal = $('login-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    // Pre-fill saved token
    const tokenInput = $('api-token-input');
    const savedToken = localStorage.getItem('deriv_api_token');
    if (tokenInput && savedToken) tokenInput.value = savedToken;
    hideLoginError();
    setTimeout(() => { if (tokenInput) tokenInput.focus(); }, 100);
};

window.closeLoginModal = function () {
    const modal = $('login-modal');
    if (modal) modal.style.display = 'none';
    resetConnectBtn();
};

window.doLogin = function () {
    const tokenInput = $('api-token-input');
    if (!tokenInput) return;
    const token = tokenInput.value.trim();

    if (!token) {
        showLoginError('Please paste your API token.');
        return;
    }
    if (token.length < 10) {
        showLoginError('Token seems too short. Please copy the full token from Deriv.');
        return;
    }

    // Show loading state
    const btn = $('connect-btn-text');
    if (btn) btn.textContent = '⏳ Connecting...';
    const connectBtn = $('connect-btn');
    if (connectBtn) connectBtn.disabled = true;
    hideLoginError();

    state.apiToken = token;

    // Send authorize over existing WS connection
    if (state.ws && state.ws.readyState === WebSocket.OPEN) {
        wsSend({ authorize: token });
    } else {
        // WS not ready yet — save token and it will auth on connect
        localStorage.setItem('deriv_api_token', token);
        showLoginError('WebSocket not ready. Token saved — it will authorize when connected.');
        resetConnectBtn();
    }
};

window.toggleTokenVisibility = function () {
    const input = $('api-token-input');
    const btn = $('token-eye-btn');
    if (!input) return;
    if (input.type === 'password') {
        input.type = 'text';
        if (btn) btn.textContent = '🙈';
    } else {
        input.type = 'password';
        if (btn) btn.textContent = '👁';
    }
};

// Logout
document.addEventListener('DOMContentLoaded', () => {
    const logoutBtn = $('logout-btn');
    if (logoutBtn) {
        logoutBtn.addEventListener('click', () => {
            state.apiToken = null;
            state.accountInfo = null;
            localStorage.removeItem('deriv_api_token');

            const bar = $('account-info-bar');
            const loginBtn = $('login-btn');
            if (bar) bar.style.display = 'none';
            if (loginBtn) loginBtn.style.display = 'inline-flex';

            setStatus('Logged out. Market data still live.', true);
        });
    }

    // Allow Enter key in token input
    const tokenInput = $('api-token-input');
    if (tokenInput) {
        tokenInput.addEventListener('keydown', e => { if (e.key === 'Enter') window.doLogin(); });
    }

    // Auto-authorize if token exists in state at startup
    if (state.apiToken) {
        // Will be triggered once WS connects (via connectWS onopen patch)
        setTimeout(() => {
            if (state.ws && state.ws.readyState === WebSocket.OPEN && state.apiToken) {
                authorizeWS();
            }
        }, 2000);
    }

    // Bot Editor Event Listeners
    if (DOM.botFileInput) {
        DOM.botFileInput.addEventListener('change', handleBotFileUpload);
    }
    if (DOM.downloadBotBtn) {
        DOM.downloadBotBtn.addEventListener('click', downloadEditedBot);
    }
    if (DOM.clearBotBtn) {
        DOM.clearBotBtn.addEventListener('click', () => {
            if (confirm('Are you sure you want to clear the editor?')) {
                DOM.botEditor.value = '';
            }
        });
    }
});

/**
 * Handle bot strategy file upload
 */
function handleBotFileUpload(e) {
    const file = e.target.files[0];
    if (!file) return;

    const reader = new FileReader();
    reader.onload = function (event) {
        DOM.botEditor.value = event.target.result;
        setStatus(`Bot file "${file.name}" loaded successfully.`, true);
    };
    reader.onerror = function () {
        setStatus('Error reading file.', false);
    };
    reader.readAsText(file);
}

/**
 * Download the edited bot content
 */
function downloadEditedBot() {
    const content = DOM.botEditor.value;
    if (!content) {
        alert('Editor is empty. Nothing to download.');
        return;
    }

    const blob = new Blob([content], { type: 'text/xml' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'edited_deriv_bot.xml';
    document.body.appendChild(a);
    a.click();

    setTimeout(() => {
        document.body.removeChild(a);
        window.URL.revokeObjectURL(url);
    }, 0);

    setStatus('Bot file downloaded.', true);
}

function showLoginError(msg) {
    const el = $('login-error');
    if (!el) return;
    el.textContent = '⚠️ ' + msg;
    el.classList.remove('hidden');
    el.style.display = 'block';
}

function hideLoginError() {
    const el = $('login-error');
    if (!el) return;
    el.classList.add('hidden');
    el.style.display = 'none';
}

function resetConnectBtn() {
    const btn = $('connect-btn-text');
    const connectBtn = $('connect-btn');
    if (btn) btn.textContent = '?? Connect Account';
    if (connectBtn) connectBtn.disabled = false;
}


