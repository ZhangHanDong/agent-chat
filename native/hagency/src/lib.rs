use hagency_core::custody::{Delivery, MAX_DELIVERY_BYTES};
use hagency_store::{Error, Store};
use salvo::prelude::*;
use sha2::{Digest, Sha256};
use std::{
    net::SocketAddr,
    sync::Arc,
    time::{Duration, SystemTime, UNIX_EPOCH},
};
use subtle::ConstantTimeEq;
use tokio::sync::Semaphore;

#[derive(Clone)]
pub struct App {
    store: Store,
    token_hash: [u8; 32],
    authority: String,
    requests: Arc<Semaphore>,
}

impl App {
    pub fn new(store: Store, token: &[u8], address: SocketAddr) -> Result<Self, Error> {
        if (!address.ip().is_loopback() || address.port() == 0)
            || token.len() < 32
            || token.len() > 256
            || !token.iter().all(u8::is_ascii_graphic)
        {
            return Err(hagency_core::InvalidInput(
                "use a loopback address and a 32..256 byte ASCII token",
            )
            .into());
        }
        Ok(Self {
            store,
            token_hash: Sha256::digest(token).into(),
            authority: address.to_string(),
            requests: Arc::new(Semaphore::new(8)),
        })
    }

    pub fn router(self) -> Router {
        Router::new()
            .hoop(self)
            .push(Router::with_path("health").get(health))
            .push(
                Router::with_path("api/native/v1")
                    .hoop(authorize)
                    .push(Router::with_path("capabilities").get(capabilities))
                    .push(Router::with_path("custody").post(receive)),
            )
    }
}

#[handler]
async fn health(res: &mut Response) {
    res.render(Json(
        serde_json::json!({"status":"ok", "implementation":"rust", "stage":"foundation"}),
    ));
}

#[handler]
async fn capabilities(res: &mut Response) {
    res.render(Json(
        serde_json::json!({"custody":true, "agent_execution":false, "palpo_transport":false,
        "matrix_crypto":false, "production_api_parity":false}),
    ));
}

fn refusal(res: &mut Response, status: StatusCode, code: &str) {
    res.status_code(status);
    res.render(Json(serde_json::json!({"ok":false,"code":code})));
}

#[handler]
async fn authorize(req: &mut Request, depot: &mut Depot, res: &mut Response, ctrl: &mut FlowCtrl) {
    res.headers_mut()
        .insert("cache-control", "no-store".parse().expect("static header"));
    let Ok(app) = depot.get_typed::<App>() else {
        refusal(res, StatusCode::SERVICE_UNAVAILABLE, "unavailable");
        ctrl.skip_rest();
        return;
    };
    let headers = req.headers();
    let forbidden = headers.contains_key("origin")
        || headers.contains_key("sec-fetch-site")
        || headers.contains_key("forwarded")
        || headers.contains_key("x-forwarded-for")
        || headers.get("host").and_then(|v| v.to_str().ok()) != Some(app.authority.as_str());
    if forbidden {
        refusal(res, StatusCode::FORBIDDEN, "local_authority_required");
        ctrl.skip_rest();
        return;
    }
    let bearer = if headers.get_all("authorization").iter().count() == 1 {
        headers
            .get("authorization")
            .and_then(|v| v.to_str().ok())
            .and_then(|s| s.strip_prefix("Bearer "))
    } else {
        None
    };
    let valid = bearer.filter(|s| s.len() <= 256).is_some_and(|s| {
        let hash: [u8; 32] = Sha256::digest(s.as_bytes()).into();
        bool::from(hash.ct_eq(&app.token_hash))
    });
    if !valid {
        refusal(res, StatusCode::UNAUTHORIZED, "operator_auth_required");
        ctrl.skip_rest();
    }
}

#[handler]
async fn receive(req: &mut Request, depot: &mut Depot, res: &mut Response) {
    let Ok(app) = depot.get_typed::<App>() else {
        refusal(res, StatusCode::SERVICE_UNAVAILABLE, "unavailable");
        return;
    };
    let Ok(_permit) = app.requests.clone().try_acquire_owned() else {
        refusal(res, StatusCode::SERVICE_UNAVAILABLE, "busy");
        return;
    };
    if req
        .headers()
        .get("content-type")
        .and_then(|v| v.to_str().ok())
        .map(|s| s.split(';').next().unwrap_or_default().trim())
        != Some("application/json")
    {
        refusal(res, StatusCode::UNSUPPORTED_MEDIA_TYPE, "json_required");
        return;
    }
    if req
        .headers()
        .get("content-length")
        .and_then(|v| v.to_str().ok())
        .and_then(|v| v.parse::<usize>().ok())
        .is_some_and(|n| n > MAX_DELIVERY_BYTES)
    {
        refusal(res, StatusCode::PAYLOAD_TOO_LARGE, "body_too_large");
        return;
    }
    let bytes = match tokio::time::timeout(
        Duration::from_secs(2),
        req.payload_with_max_size(MAX_DELIVERY_BYTES),
    )
    .await
    {
        Ok(Ok(bytes)) => bytes,
        Ok(Err(_)) => {
            refusal(res, StatusCode::PAYLOAD_TOO_LARGE, "body_rejected");
            return;
        }
        Err(_) => {
            refusal(res, StatusCode::REQUEST_TIMEOUT, "body_timeout");
            return;
        }
    };
    let delivery: Delivery = match serde_json::from_slice(bytes) {
        Ok(delivery) => delivery,
        Err(_) => {
            refusal(res, StatusCode::BAD_REQUEST, "invalid_delivery");
            return;
        }
    };
    let now = match SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .ok()
        .and_then(|d| u64::try_from(d.as_millis()).ok())
    {
        Some(now) => now,
        None => {
            refusal(res, StatusCode::SERVICE_UNAVAILABLE, "clock_unavailable");
            return;
        }
    };
    match app.store.receive(delivery, now).await {
        Ok(receipt) => {
            res.status_code(StatusCode::ACCEPTED);
            res.render(Json(receipt));
        }
        Err(error) => {
            let (status, code) = match error {
                Error::Invalid(_) => (StatusCode::BAD_REQUEST, "invalid_delivery"),
                Error::Conflict => (StatusCode::CONFLICT, "idempotency_conflict"),
                Error::Generation => (StatusCode::CONFLICT, "generation_mismatch"),
                Error::Capacity => (
                    StatusCode::SERVICE_UNAVAILABLE,
                    "custody_capacity_exhausted",
                ),
                Error::Busy => (StatusCode::SERVICE_UNAVAILABLE, "busy"),
                Error::OutcomeUnknown => (StatusCode::GATEWAY_TIMEOUT, "outcome_unknown"),
                _ => (StatusCode::SERVICE_UNAVAILABLE, "storage_unavailable"),
            };
            refusal(res, status, code);
        }
    }
}

#[handler]
impl App {
    async fn handle(&self, depot: &mut Depot) {
        depot.insert_typed(self.clone());
    }
}
