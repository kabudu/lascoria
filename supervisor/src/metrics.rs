use serde_json::{Value, json};
use std::{collections::VecDeque, time::Instant};

pub struct Metrics {
    start: Instant,
    requests: u64,
    failures: u64,
    bytes: u64,
    samples: VecDeque<f64>,
    queue: VecDeque<f64>,
}
impl Metrics {
    pub fn new() -> Self {
        Self {
            start: Instant::now(),
            requests: 0,
            failures: 0,
            bytes: 0,
            samples: VecDeque::with_capacity(256),
            queue: VecDeque::with_capacity(256),
        }
    }
    pub fn record(&mut self, elapsed_ms: f64, failed: bool, bytes: usize) {
        self.requests += 1;
        self.failures += u64::from(failed);
        self.bytes += bytes as u64;
        if self.samples.len() == 256 {
            self.samples.pop_front();
        }
        self.samples.push_back(elapsed_ms);
    }
    pub fn record_queue(&mut self, ms: f64) {
        if self.queue.len() == 256 {
            self.queue.pop_front();
        }
        self.queue.push_back(ms);
    }
    pub fn snapshot(&self) -> Value {
        let percentile = |column: usize| {
            let mut values: Vec<f64> = if column == 0 {
                self.samples.iter().copied().collect()
            } else {
                self.queue.iter().copied().collect()
            };
            values.sort_by(f64::total_cmp);
            if values.is_empty() {
                0.0
            } else {
                values[(values.len() * 95).div_ceil(100) - 1]
            }
        };
        json!({"uptimeMs":self.start.elapsed().as_millis(), "requests":self.requests,"failures":self.failures,"responseBytes":self.bytes,"sampleCount":self.samples.len(),"sampleLimit":256,"requestP95Ms":percentile(0),"queueSampleCount":self.queue.len(),"queueP95Ms":percentile(1)})
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_window_and_lifetime_totals() {
        let mut metrics = Metrics::new();
        for i in 0..1000 {
            metrics.record(i as f64, i % 2 == 0, 10);
            metrics.record_queue((i * 2) as f64);
        }
        let value = metrics.snapshot();
        assert_eq!(value["requests"], 1000);
        assert_eq!(value["failures"], 500);
        assert_eq!(value["sampleCount"], 256);
        assert_eq!(value["responseBytes"], 10000);
        assert_eq!(value["requestP95Ms"], 987.0);
        assert_eq!(value["queueP95Ms"], 1974.0);
    }
}
