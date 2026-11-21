use std::fmt;
mod util;

/// A point in space.
pub struct Point<'a> {
    name: &'a str,
}

pub async fn compute<'a>(p: &'a Point) -> i32 {
    let s = "{";
    if true { 1 } else { 2 }
}
