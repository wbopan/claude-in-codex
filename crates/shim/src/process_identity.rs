use std::error::Error;

use codexhost_platform::process_exists;
use codexhost_platform::{PlatformError, ProcessSnapshot, process_snapshot};

#[derive(Debug, PartialEq, Eq)]
pub(crate) enum RecordedProcessObservation {
    Matching(ProcessSnapshot),
    Missing,
    Reused,
}

pub(crate) fn current_process_snapshot(
    process_id: u32,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    match process_snapshot(process_id) {
        Ok(snapshot) => Ok(Some(snapshot)),
        Err(PlatformError::NotFound(_)) => Ok(None),
        Err(_) if !process_exists(process_id) => Ok(None),
        Err(error) => Err(error.into()),
    }
}

pub(crate) fn recorded_process_identity(
    process_id: u32,
    started_at_micros: u64,
) -> Result<RecordedProcessObservation, Box<dyn Error>> {
    Ok(match current_process_snapshot(process_id)? {
        Some(snapshot) if snapshot.started_at_micros == started_at_micros => {
            RecordedProcessObservation::Matching(snapshot)
        }
        Some(_) => RecordedProcessObservation::Reused,
        None => RecordedProcessObservation::Missing,
    })
}

pub(crate) fn recorded_process_snapshot(
    process_id: u32,
    started_at_micros: u64,
) -> Result<Option<ProcessSnapshot>, Box<dyn Error>> {
    Ok(
        match recorded_process_identity(process_id, started_at_micros)? {
            RecordedProcessObservation::Matching(snapshot) => Some(snapshot),
            RecordedProcessObservation::Missing | RecordedProcessObservation::Reused => None,
        },
    )
}
