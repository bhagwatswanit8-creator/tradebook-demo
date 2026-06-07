//+------------------------------------------------------------------+
//|                                         SwanXmSync.mq5           |
//|                    SwanXm Trade Book — Direct MT5 Push Sync      |
//|  Pushes open positions + trade history directly to SwanXm server |
//+------------------------------------------------------------------+
#property copyright "SwanXm Trade Book"
#property description "Syncs MT5 trade history and open positions to SwanXm Trade Book automatically"
#property version   "1.10"
#property strict

//--- Input parameters
input string ApiUrl      = "PASTE_YOUR_SERVER_URL_HERE/api/mt5/ea-push"; // SwanXm Server URL (copy from MT5 panel in app)
input string ApiToken    = "PASTE_YOUR_EA_TOKEN_HERE";                   // EA Token (copy from MT5 panel in app)
input int    SyncSeconds = 30;                                            // Auto-sync every N seconds (0 = manual only)
input bool   SyncOnStart = true;                                          // Sync immediately on attach
input int    HistoryDays = 90;                                            // Days of trade history to include

//--- Internal state
bool     syncRunning  = false;
datetime lastSyncOk   = 0;

//+------------------------------------------------------------------+
int OnInit() {
   if(StringFind(ApiUrl, "PASTE_YOUR") >= 0 || StringLen(ApiUrl) < 15) {
      Alert("SwanXmSync: Set ApiUrl to your SwanXm server URL (copy from the MT5 panel in your app)");
      return INIT_FAILED;
   }
   if(StringFind(ApiToken, "PASTE_YOUR") >= 0 || StringLen(ApiToken) < 10) {
      Alert("SwanXmSync: Set ApiToken from your SwanXm MT5 panel (click 'Copy EA Token')");
      return INIT_FAILED;
   }

   if(SyncOnStart) DoSync();
   if(SyncSeconds > 0) EventSetTimer(SyncSeconds);

   Print("SwanXmSync v1.10 ready | URL: ", ApiUrl, " | interval: ", SyncSeconds, "s");
   return INIT_SUCCEEDED;
}

void OnDeinit(const int reason) {
   EventKillTimer();
   Comment("");
}

void OnTimer() { DoSync(); }
void OnTick()  {}

//+------------------------------------------------------------------+
void DoSync() {
   if(syncRunning) return;
   syncRunning = true;

   string payload = BuildPayload();
   string response = HttpPost(ApiUrl, ApiToken, payload);

   if(StringLen(response) > 0 && StringFind(response, "\"ok\":true") >= 0) {
      lastSyncOk = TimeCurrent();
      string msg = "SwanXmSync OK | " + TimeToString(lastSyncOk, TIME_DATE|TIME_MINUTES) +
                   " | Positions: " + IntegerToString(PositionsTotal());
      Comment(msg);
      Print(msg);
   } else {
      string errMsg = "SwanXmSync FAILED | Response: " + (StringLen(response) > 0 ? response : "no response — check URL/token");
      Comment(errMsg);
      Print(errMsg);
   }

   syncRunning = false;
}

//+------------------------------------------------------------------+
string BuildPayload() {
   // Account info
   string loginStr  = IntegerToString(AccountInfoInteger(ACCOUNT_LOGIN));
   string nameStr   = AccountInfoString(ACCOUNT_NAME);
   string srvStr    = AccountInfoString(ACCOUNT_SERVER);
   double balance   = AccountInfoDouble(ACCOUNT_BALANCE);
   double equity    = AccountInfoDouble(ACCOUNT_EQUITY);
   double profit    = AccountInfoDouble(ACCOUNT_PROFIT);
   string currency  = AccountInfoString(ACCOUNT_CURRENCY);
   int    leverage  = (int)AccountInfoInteger(ACCOUNT_LEVERAGE);

   string json = "{";
   json += "\"accountLogin\":\""  + loginStr               + "\",";
   json += "\"accountName\":\""   + EscJson(nameStr)       + "\",";
   json += "\"accountServer\":\"" + EscJson(srvStr)        + "\",";
   json += "\"balance\":"         + DoubleToString(balance, 2)  + ",";
   json += "\"equity\":"          + DoubleToString(equity, 2)   + ",";
   json += "\"floatingPnl\":"     + DoubleToString(profit, 2)   + ",";
   json += "\"currency\":\""      + currency               + "\",";
   json += "\"leverage\":"        + IntegerToString(leverage)   + ",";
   json += "\"positions\":"       + BuildPositions()        + ",";
   json += "\"history\":"         + BuildHistory();
   json += "}";
   return json;
}

//+------------------------------------------------------------------+
string BuildPositions() {
   string json = "[";
   int total = PositionsTotal();
   bool first = true;

   for(int i = 0; i < total; i++) {
      ulong ticket = PositionGetTicket(i);
      if(ticket == 0) continue;

      string   sym       = PositionGetString(POSITION_SYMBOL);
      double   openPrice = PositionGetDouble(POSITION_PRICE_OPEN);
      double   curPrice  = PositionGetDouble(POSITION_PRICE_CURRENT);
      double   sl        = PositionGetDouble(POSITION_SL);
      double   tp        = PositionGetDouble(POSITION_TP);
      double   lots      = PositionGetDouble(POSITION_VOLUME);
      double   pnl       = PositionGetDouble(POSITION_PROFIT);
      double   swap      = PositionGetDouble(POSITION_SWAP);
      datetime openTime  = (datetime)PositionGetInteger(POSITION_TIME);
      int      posType   = (int)PositionGetInteger(POSITION_TYPE);
      string   dir       = (posType == POSITION_TYPE_BUY) ? "long" : "short";
      string   comment   = PositionGetString(POSITION_COMMENT);

      if(!first) json += ",";
      first = false;
      json += "{";
      json += "\"ticket\":"      + IntegerToString((long)ticket) + ",";
      json += "\"symbol\":\""    + sym                           + "\",";
      json += "\"direction\":\"" + dir                           + "\",";
      json += "\"entry\":"       + DoubleToString(openPrice, 5)  + ",";
      json += "\"currentPrice\":" + DoubleToString(curPrice, 5) + ",";
      json += "\"sl\":"          + DoubleToString(sl, 5)         + ",";
      json += "\"tp\":"          + DoubleToString(tp, 5)         + ",";
      json += "\"lotSize\":"     + DoubleToString(lots, 2)       + ",";
      json += "\"pnl\":"         + DoubleToString(pnl, 2)        + ",";
      json += "\"swap\":"        + DoubleToString(swap, 2)       + ",";
      json += "\"openTime\":\"" + TimeToString(openTime, TIME_DATE|TIME_MINUTES) + "\",";
      json += "\"comment\":\""   + EscJson(comment)              + "\"";
      json += "}";
   }
   json += "]";
   return json;
}

//+------------------------------------------------------------------+
string BuildHistory() {
   datetime fromDate = TimeCurrent() - (datetime)((long)HistoryDays * 86400LL);
   HistorySelect(fromDate, TimeCurrent() + 86400);

   string json = "[";
   int total = HistoryDealsTotal();
   bool first = true;

   for(int i = 0; i < total; i++) {
      ulong ticket = HistoryDealGetTicket(i);
      if(ticket == 0) continue;

      int  dealType = (int)HistoryDealGetInteger(ticket, DEAL_TYPE);
      // Only BUY/SELL trade deals (skip deposits, credits, etc.)
      if(dealType != DEAL_TYPE_BUY && dealType != DEAL_TYPE_SELL) continue;

      long entry = HistoryDealGetInteger(ticket, DEAL_ENTRY);
      // Only exit (close) deals for history — IN deals don't have realised PnL
      if(entry != DEAL_ENTRY_OUT && entry != DEAL_ENTRY_INOUT) continue;

      string   sym     = HistoryDealGetString(ticket, DEAL_SYMBOL);
      double   price   = HistoryDealGetDouble(ticket, DEAL_PRICE);
      double   lots    = HistoryDealGetDouble(ticket, DEAL_VOLUME);
      double   pnl     = HistoryDealGetDouble(ticket, DEAL_PROFIT);
      double   swap    = HistoryDealGetDouble(ticket, DEAL_SWAP);
      double   comm    = HistoryDealGetDouble(ticket, DEAL_COMMISSION);
      datetime t       = (datetime)HistoryDealGetInteger(ticket, DEAL_TIME);
      long     posId   = HistoryDealGetInteger(ticket, DEAL_POSITION_ID);
      string   comment = HistoryDealGetString(ticket, DEAL_COMMENT);
      // SELL deal = closing a BUY (long) position; BUY deal = closing a SELL (short)
      string   dir     = (dealType == DEAL_TYPE_SELL) ? "long" : "short";

      if(!first) json += ",";
      first = false;
      json += "{";
      json += "\"ticket\":"      + IntegerToString((long)ticket) + ",";
      json += "\"positionId\":"  + IntegerToString(posId)        + ",";
      json += "\"symbol\":\""    + sym                           + "\",";
      json += "\"direction\":\"" + dir                           + "\",";
      json += "\"exitPrice\":"   + DoubleToString(price, 5)      + ",";
      json += "\"lotSize\":"     + DoubleToString(lots, 2)       + ",";
      json += "\"pnl\":"         + DoubleToString(pnl, 2)        + ",";
      json += "\"swap\":"        + DoubleToString(swap, 2)       + ",";
      json += "\"commission\":"  + DoubleToString(comm, 2)       + ",";
      json += "\"closedAt\":\"" + TimeToString(t, TIME_DATE|TIME_MINUTES) + "\",";
      json += "\"comment\":\""   + EscJson(comment)              + "\"";
      json += "}";
   }

   json += "]";
   return json;
}

//+------------------------------------------------------------------+
string HttpPost(const string url, const string token, const string body) {
   char  postData[];
   char  result[];
   string headers      = "Content-Type: application/json\r\nAuthorization: Bearer " + token + "\r\n";
   string resultHeaders;

   StringToCharArray(body, postData, 0, StringLen(body));

   int code = WebRequest("POST", url, headers, 10000, postData, result, resultHeaders);
   if(code == -1) {
      int err = GetLastError();
      if(err == 4014) {
         Print("SwanXmSync: URL not whitelisted. Go to: Tools > Options > Expert Advisors > Allow WebRequests for listed URLs, and add: ", url);
         Alert("SwanXmSync needs permission.\n\nIn MetaTrader 5:\n1. Go to Tools > Options > Expert Advisors\n2. Check 'Allow WebRequest for listed URL'\n3. Click '+' and paste: " + url);
      } else {
         Print("SwanXmSync: WebRequest error code ", err);
      }
      return "";
   }
   return CharArrayToString(result);
}

//+------------------------------------------------------------------+
string EscJson(const string s) {
   string out = s;
   StringReplace(out, "\\", "\\\\");
   StringReplace(out, "\"", "\\\"");
   StringReplace(out, "\n", "\\n");
   StringReplace(out, "\r", "\\r");
   StringReplace(out, "\t", "\\t");
   return out;
}
